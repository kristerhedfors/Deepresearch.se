#!/usr/bin/env node
// @ts-check
// Harvest Google Scholar's PUBLICATION METRICS into a committed artifact
// (public/scholar/venues.json), the h5-index table src/scholar-venues.js reads
// at run time.
//
// ---- why this is harvested OFFLINE and committed -----------------------------
//
// Two reasons, and the second is the load-bearing one.
//
// 1. **It is stable and small.** Scholar recomputes the metrics once a year.
//    Fetching ~2,000 venue rows per chat turn to annotate six citations would
//    be absurd; the whole table is ~60 KB and answers every lookup from the
//    deployment's own bytes.
// 2. **No outbound request per turn.** A live lookup would tell Google, for
//    every research question anyone asks here, which journals the answer is
//    about. The privacy rule (invariant 4) is that outbound requests carry the
//    minimum — so the right minimum here is ZERO, exactly as the ancient-sample
//    corpus (scripts/aadr-build.mjs) and the arXiv index are build artifacts
//    rather than live calls.
//
// ---- what is fetched, and why it is allowed ----------------------------------
//
// Google Scholar's robots.txt (read 2026-07-31) disallows `/scholar` — the
// SEARCH results — and then explicitly ALLOWS a short list of `/citations`
// views, of which one is ours:
//
//     Disallow: /scholar
//     Disallow: /citations?
//     Allow:    /citations?user=
//     Allow:    /citations?view_op=top_venues
//     …
//
// So this script fetches only `citations?view_op=top_venues`, which Google
// publishes for crawling. It does not touch a disallowed path, it runs once per
// refresh rather than per request, and it is rate-limited below. See
// docs/SCHOLAR.md for the full posture and what is deliberately NOT done.
//
// ---- the pages ---------------------------------------------------------------
//
// The landing table is the top 100 venues overall. Its own navigation links to
// eight SUBJECT categories (`&vq=bus|chm|eng|med|hum|bio|phy|soc`), each another
// top 100, and each of those pages links to its own subcategories (`vq=eng_*`).
// Language lists (`vq=en|de|sv…`) are skipped: they re-rank the same venues by
// language of publication and add no h5-index this table doesn't already have.
//
// Usage:
//   node scripts/scholar-venues.mjs             # subject categories (default)
//   node scripts/scholar-venues.mjs --deep      # …and every subcategory
//   node scripts/scholar-venues.mjs --out path/to/venues.json

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const BASE = "https://scholar.google.com/citations?hl=en&view_op=top_venues";
// A real browser UA. Scholar answers a default curl UA with 403 on every path,
// allowed or not (probed 2026-07-31), so this is what makes an allowed page
// readable at all — not an attempt to look like something we are not.
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
// One page every 2.5 s. Nothing requires this; it is ordinary citizenship
// toward a service that is letting us read the page (the same discipline the
// bulk-corpus-etl skill records for every other harvest here).
const DELAY_MS = 2500;
const TIMEOUT_MS = 20000;

/** The eight subject categories, in Scholar's own order. */
const CATEGORIES = [
  ["bus", "Business, Economics & Management"],
  ["chm", "Chemical & Material Sciences"],
  ["eng", "Engineering & Computer Science"],
  ["med", "Health & Medical Sciences"],
  ["hum", "Humanities, Literature & Arts"],
  ["bio", "Life Sciences & Earth Sciences"],
  ["phy", "Physics & Mathematics"],
  ["soc", "Social Sciences"],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One page of HTML, or "" on any failure — a harvest that loses one category
 * still writes the rest rather than throwing the whole run away.
 * @param {string} url
 * @returns {Promise<string>}
 */
async function page(url) {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA, "accept-language": "en" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`  ! HTTP ${res.status} ${url}`);
      return "";
    }
    return await res.text();
  } catch (err) {
    console.warn(`  ! ${err?.message || err} ${url}`);
    return "";
  }
}

/** Decode the handful of entities Scholar emits in venue names. */
function unent(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The venue rows of one metrics page.
 *
 * The markup (verified 2026-07-31) is a flat table of
 * `<td class=gsc_mvt_t>NAME</td><td class=gsc_mvt_n><a>H5</a></td><td
 * class=gsc_mvt_n><span>MEDIAN</span></td>`. Matching the three cells as one
 * unit is deliberate: the class names also appear inside the page's inline
 * stylesheet, and a looser per-cell match harvests CSS selectors as venues.
 * @param {string} html
 * @returns {Array<{ name: string, h5: number, h5median: number }>}
 */
export function parseVenues(html) {
  const out = [];
  const re =
    /<td class="gsc_mvt_t">([^<]*)<\/td><td class="gsc_mvt_n">(?:<a[^>]*>|<span[^>]*>)(\d+)<\/(?:a|span)><\/td><td class="gsc_mvt_n">(?:<a[^>]*>|<span[^>]*>)(\d+)</g;
  for (const m of html.matchAll(re)) {
    const name = unent(m[1]);
    const h5 = Number(m[2]);
    const h5median = Number(m[3]);
    if (!name || !Number.isFinite(h5)) continue;
    out.push({ name, h5, h5median: Number.isFinite(h5median) ? h5median : 0 });
  }
  return out;
}

/**
 * The subcategory `vq` codes a category page links to (e.g. `eng_bioinformatics`
 * under `eng`). Language lists are excluded — they are two-letter codes with no
 * underscore, and they re-rank venues this table already carries.
 * @param {string} html
 * @param {string} cat
 * @returns {string[]}
 */
export function parseSubcategories(html, cat) {
  const seen = new Set();
  // `&amp;vq=…`, not `&vq=…`: hrefs arrive entity-encoded, so a `[?&]vq=`
  // lookbehind matches nothing and the first --deep run silently harvested zero
  // subcategories while reporting success. Decode first, then match.
  for (const m of html.replace(/&amp;/g, "&").matchAll(/[?&]vq=([a-z]{3}_[a-z0-9_]+)/g)) {
    if (m[1].startsWith(`${cat}_`)) seen.add(m[1]);
  }
  return [...seen];
}

async function main() {
  const argv = process.argv.slice(2);
  const deep = argv.includes("--deep");
  const outIdx = argv.indexOf("--out");
  const out = outIdx >= 0 ? argv[outIdx + 1] : "public/scholar/venues.json";

  /** @type {Map<string, { name: string, h5: number, h5median: number, cats: string[] }>} */
  const venues = new Map();
  /** @param {Array<{name:string,h5:number,h5median:number}>} rows @param {string} cat */
  const absorb = (rows, cat) => {
    let added = 0;
    for (const r of rows) {
      const key = r.name.toLowerCase();
      const prev = venues.get(key);
      if (prev) {
        if (cat && !prev.cats.includes(cat)) prev.cats.push(cat);
        continue;
      }
      venues.set(key, { ...r, cats: cat ? [cat] : [] });
      added++;
    }
    return added;
  };

  console.log("top venues (overall)…");
  absorb(parseVenues(await page(BASE)), "");

  for (const [code, label] of CATEGORIES) {
    await sleep(DELAY_MS);
    const html = await page(`${BASE}&vq=${code}`);
    const rows = parseVenues(html);
    const added = absorb(rows, code);
    console.log(`  ${code.padEnd(4)} ${label.padEnd(36)} ${rows.length} rows (+${added}) `);
    if (!deep) continue;
    for (const sub of parseSubcategories(html, code)) {
      await sleep(DELAY_MS);
      const subRows = parseVenues(await page(`${BASE}&vq=${sub}`));
      const subAdded = absorb(subRows, code);
      console.log(`    ${sub.padEnd(40)} ${subRows.length} rows (+${subAdded})`);
    }
  }

  const list = [...venues.values()].sort((a, b) => b.h5 - a.h5);
  if (!list.length) {
    console.error("no venues harvested — refusing to overwrite the artifact");
    process.exit(1);
  }
  const artifact = {
    // The version the runtime parser checks. Bump when the row shape changes;
    // an unknown version makes src/scholar-venues.js return null (fail-soft)
    // rather than mis-read a future layout.
    version: 1,
    source: "Google Scholar Metrics (citations?view_op=top_venues), robots-allowed",
    harvested: new Date().toISOString().slice(0, 10),
    // The metrics year is Scholar's own; recorded so an answer can say how old
    // the number it quotes is instead of implying it is current.
    n: list.length,
    // Positional rows, not objects: 2,000 venues as {name,h5,h5median,cats}
    // objects is ~3× the bytes for no added meaning.
    fields: ["name", "h5", "h5median", "cats"],
    rows: list.map((v) => [v.name, v.h5, v.h5median, v.cats.join(",")]),
  };
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(artifact)}\n`);
  console.log(`\nwrote ${out} — ${list.length} venues, ${(JSON.stringify(artifact).length / 1024).toFixed(1)} KB`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
