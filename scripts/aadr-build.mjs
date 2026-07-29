#!/usr/bin/env node
// Builds the ANCIENT-SAMPLE ARTIFACT — public/aadr/samples.tsv.json, the
// structured half of the palaeogenomics agent (src/aadr.js).
//
// WHY AN ARTIFACT AND NOT A LIVE CALL. The Poseidon server answers
// /individuals with every individual it hosts in ONE response — 46k rows,
// ~28 MB of JSON. There is no filter grammar on the wire: no bounding box, no
// date window, no haplogroup prefix. So a live tier would fetch the whole
// corpus to answer "samples within 200 km of Uppsala dated 5000-4000 BP",
// every turn, from a Worker with a request CPU budget. Building it ONCE into a
// compact artifact makes the query local, deterministic and free — and it is
// the same shape the arXiv RAG tier settled on for the same reason
// (src/arxiv-rag.js: get the corpus out of the request path).
//
// It is also the PRIVACY posture this project exists to demonstrate. With the
// artifact in the deploy, a structured sample query reaches NO third party at
// all: the question never leaves the Worker, and Poseidon never learns that
// anyone asked. A live tier would leak the shape of every query to a server in
// Germany. Rebuilding is an explicit, occasional, offline act — run by a human
// with this script, reviewed as a diff.
//
// ---- the upstream, established empirically (2026-07-29, curl + node) --------
//
// Host `https://server.poseidon-adna.org`, a Haskell service (poseidon-server
// 2.2.0.1) wrapping the community's public archives. Two endpoints matter:
//
//   GET /packages     → ApiReturnPackageInfo. One row per PACKAGE (a published
//                       study repackaged to the Poseidon standard), carrying
//                       packageTitle, packageVersion, nrIndividuals, a prose
//                       description and lastModified.
//   GET /individuals  → ApiReturnExtIndividualInfo. One row per INDIVIDUAL:
//                       poseidonID, groupNames[], packageTitle, isLatest — and
//                       NOTHING else unless you ask.
//
// The whole point is the "ask": `?additionalJannoColumns=A,B,C` returns those
// .janno columns as an `additionalJannoColumns` array of [name, value] PAIRS
// (not an object), in the order requested. Missing values come back as the
// STRING "n/a", never null or absent — so every column needs the same n/a
// scrub, and a naive `if (v)` keeps "n/a" as if it were data.
//
// Measured response sizes: bare /individuals is 8.1 MB; with the 16 columns
// below it is 27.9 MB. Both are single un-paginated responses, so the fetch is
// slow (tens of seconds) but happens once per rebuild.
//
// Most packages are AADR-derived (the Allen Ancient DNA Resource repackaged —
// their Publication column carries an `AADR` key), which is why this artifact
// is named for AADR: it is the compendium's content, reached through the API
// that actually serves it row by row. Nothing here parses AADR's own .anno
// files; those live on Dataverse as static GB-scale genotype bundles and are
// not what a research turn needs.
//
// ---- what is DROPPED, and why ----------------------------------------------
//
// Nothing. Every individual the server lists is kept, including present-day
// reference individuals (Date_Type "modern") — an ancestry question needs the
// modern panel a study compared its ancient samples against, so silently
// keeping only the ancient rows would answer half of every comparison. The
// artifact marks them (dtype 3) and the query core lets a caller ask for
// ancient only; it does not decide for them.
//
// Rows WITHOUT coordinates or without a date are also kept — coverage of those
// two fields is uneven upstream, and a sample with a haplogroup but no
// coordinate is still the answer to a haplogroup question. The counts block in
// the artifact reports how many rows carry each field, so an answer can say
// what it searched rather than implying the corpus is complete.
//
// ---- the artifact format ---------------------------------------------------
//
// A JSON envelope (self-describing, diffable header) whose bulk is ONE
// tab-separated string, dictionary-encoded for the repeating columns. Arrays of
// 46k JSON numbers cost brackets and quotes per element; one TSV blob costs a
// tab. Measured on this corpus the envelope is ~3.5 MB where the raw upstream
// JSON is 27.9 MB, and it parses in a Worker with a single split.
//
// Usage:
//   node scripts/aadr-build.mjs            # fetch → build → write
//   node scripts/aadr-build.mjs --check    # rebuild and diff, exit 1 on drift
//   node scripts/aadr-build.mjs --from <f> # build from a saved /individuals body

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const SERVER = "https://server.poseidon-adna.org";
const OUT = "public/aadr/samples.tsv.json";

// The .janno columns requested, in artifact column order. Keep this list in
// sync with COLUMNS in public/js/aadr-core.js — the core parses positionally.
const JANNO = [
  "Country",
  "Location",
  "Site",
  "Latitude",
  "Longitude",
  "Date_Type",
  "Date_BC_AD_Start",
  "Date_BC_AD_Median",
  "Date_BC_AD_Stop",
  "Date_C14_Uncal_BP",
  "MT_Haplogroup",
  "Y_Haplogroup",
  "Genetic_Sex",
  "Nr_SNPs",
  "Coverage_on_Target_SNPs",
  "Publication",
];

// MOJIBAKE REPAIR. The Poseidon server serves UTF-8 that was already
// double-encoded upstream: the Gotland site Västerbjers arrives as
// "VÃ¤sterbjers", Ötzi's valley as "Oetz" but Scandinavian and Iberian site
// names generally as Ã-pairs. Verified against the raw server bytes
// (2026-07-29, curl) — it is not this pipeline's decoding, so it has to be
// repaired here or every Swedish place name in the corpus stays unsearchable
// in Swedish, which defeats half of invariant 6 for this dataset.
//
// The repair is the exact inverse of the corruption (re-read the string's
// characters as Latin-1 bytes and decode them as UTF-8) and is applied ONLY
// when it is provably the right move: the string shows the Ã/Â-pair signature
// AND the re-decode produces no replacement character. Anything else is left
// exactly as it arrived.
const MOJIBAKE = /[\u00C3\u00C2][\u0080-\u00BF]/;
function demojibake(s) {
  if (!MOJIBAKE.test(s)) return s;
  try {
    const fixed = Buffer.from(s, "latin1").toString("utf8");
    return fixed.includes("�") ? s : fixed;
  } catch {
    return s;
  }
}

/** Upstream writes every missing value as the literal string "n/a". */
function clean(v) {
  if (v === null || v === undefined) return "";
  const s = demojibake(String(v).trim());
  return !s || s === "n/a" || s === "N/A" ? "" : s;
}

function num(v) {
  const s = clean(v);
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** A dictionary encoder: value → index, emitting the value list in first-seen order. */
function dictionary() {
  const index = new Map();
  const values = [];
  return {
    values,
    /** @param {string} v @returns {number} -1 for empty, so a reader can tell "unknown" from a real value */
    put(v) {
      const s = clean(v);
      if (!s) return -1;
      let i = index.get(s);
      if (i === undefined) {
        i = values.length;
        values.push(s);
        index.set(s, i);
      }
      return i;
    },
  };
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

/** Date_Type → a small enum. Anything unrecognised is 0 (unknown). */
const DATE_TYPES = { C14: 1, contextual: 2, modern: 3 };
const SEXES = { M: 1, F: 2, U: 3 };

function build(individuals, packages) {
  const country = dictionary();
  const place = dictionary();
  const group = dictionary();
  const pkg = dictionary();
  const pub = dictionary();

  const rows = [];
  const counts = { total: 0, coords: 0, dated: 0, ancient: 0, modern: 0, mt: 0, y: 0 };

  for (const ind of individuals) {
    // The server returns [name, value] PAIRS, in request order — but read them
    // by NAME rather than by position: a server version that reorders or drops
    // a column would otherwise shift every field silently.
    const j = Object.fromEntries((ind.additionalJannoColumns || []).map(([k, v]) => [k, v]));

    const lat = num(j.Latitude);
    const lon = num(j.Longitude);
    // Location is the finer of the two upstream place fields and is populated
    // far more often than Site; fall back rather than emitting both.
    const loc = clean(j.Location) || clean(j.Site);
    const dtype = DATE_TYPES[clean(j.Date_Type)] || 0;
    const dmed = num(j.Date_BC_AD_Median);
    const dstart = num(j.Date_BC_AD_Start);
    const dstop = num(j.Date_BC_AD_Stop);
    const mt = clean(j.MT_Haplogroup);
    const y = clean(j.Y_Haplogroup);

    counts.total++;
    if (lat !== null && lon !== null) counts.coords++;
    if (dmed !== null || dstart !== null) counts.dated++;
    if (dtype === 3) counts.modern++;
    else counts.ancient++;
    if (mt) counts.mt++;
    if (y) counts.y++;

    // Publication is a semicolon-joined key list ("RasmussenNature2010;AADR;
    // AADRv424"); the FIRST key is the study, the rest are compendium tags.
    const pubKey = clean(j.Publication).split(";")[0];

    rows.push([
      clean(ind.poseidonID),
      group.put((ind.groupNames || [])[0] || ""),
      country.put(j.Country),
      place.put(loc),
      // Coordinates as integer thousandths: ~110 m of resolution, which is
      // finer than any archaeological site coordinate is meaningful to, and it
      // keeps the column free of float formatting noise across rebuilds.
      lat === null ? "" : Math.round(lat * 1000),
      lon === null ? "" : Math.round(lon * 1000),
      dtype || "",
      dstart === null ? "" : Math.round(dstart),
      dmed === null ? "" : Math.round(dmed),
      dstop === null ? "" : Math.round(dstop),
      num(j.Date_C14_Uncal_BP) === null ? "" : Math.round(num(j.Date_C14_Uncal_BP)),
      mt,
      y,
      SEXES[clean(j.Genetic_Sex)] || "",
      num(j.Nr_SNPs) === null ? "" : Math.round(num(j.Nr_SNPs)),
      // Coverage as hundredths — upstream reports two decimals.
      num(j.Coverage_on_Target_SNPs) === null ? "" : Math.round(num(j.Coverage_on_Target_SNPs) * 100),
      pkg.put(clean(ind.packageTitle)),
      pub.put(pubKey),
    ].join("\t"));
  }

  // Package descriptions are the one prose field upstream carries, and they are
  // what turns a package title into a citable line ("A Palaeo-Eskimo from
  // Greenland"). Keyed by title so the core can look one up from a row.
  const packageDesc = {};
  for (const p of packages) {
    const title = clean(p.packageTitle);
    const desc = clean(p.description);
    if (title && desc) packageDesc[title] = desc;
  }

  return {
    spec: "aadr-samples/1",
    // Bumped by hand when the COLUMN LAYOUT changes; the core refuses a
    // layout it does not know rather than reading shifted fields.
    layout: 1,
    source: {
      name: "Poseidon public archives (largely AADR-derived)",
      server: SERVER,
      endpoints: ["/individuals", "/packages"],
      about: "https://www.poseidon-adna.org",
      aadr: "https://reich.hms.harvard.edu/allen-ancient-dna-resource-aadr-downloadable-genotypes-present-day-and-ancient-dna-data",
      note: "Per-individual metadata only. Genotypes stay upstream — this artifact carries no genetic data.",
    },
    counts,
    dict: {
      group: group.values,
      country: country.values,
      place: place.values,
      pkg: pkg.values,
      pub: pub.values,
    },
    packageDesc,
    columns: [
      "id", "grp", "ctry", "place", "lat", "lon",
      "dtype", "dstart", "dmed", "dstop", "c14bp",
      "mt", "y", "sex", "snps", "cov", "pkg", "pub",
    ],
    rows: rows.join("\n"),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const fromAt = args.indexOf("--from");

  let individuals;
  let packages;
  if (fromAt >= 0) {
    const body = JSON.parse(readFileSync(args[fromAt + 1], "utf8"));
    individuals = body.serverResponse.extIndInfo;
    packages = JSON.parse(readFileSync(args[fromAt + 2], "utf8")).serverResponse.packageInfo;
  } else {
    process.stderr.write("fetching /individuals (one un-paginated ~28 MB response)…\n");
    const ind = await fetchJson(`${SERVER}/individuals?additionalJannoColumns=${JANNO.join(",")}`);
    individuals = ind.serverResponse.extIndInfo;
    process.stderr.write(`  ${individuals.length} individuals\n`);
    const pk = await fetchJson(`${SERVER}/packages`);
    packages = pk.serverResponse.packageInfo;
    process.stderr.write(`  ${packages.length} packages\n`);
  }

  // isLatest guards against a corpus that ships several versions of the same
  // package: without it the same individual appears once per version.
  const latest = individuals.filter((i) => i.isLatest !== false);
  const artifact = build(latest, packages.filter((p) => p.isLatest !== false));
  const json = JSON.stringify(artifact);

  if (check) {
    const have = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
    if (have === json) {
      process.stderr.write(`aadr: ${OUT} is current (${artifact.counts.total} individuals)\n`);
      return;
    }
    process.stderr.write(`aadr: ${OUT} DRIFTS from a fresh build — run \`npm run bundle:aadr\`\n`);
    process.exit(1);
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, json);
  const mb = (json.length / 1024 / 1024).toFixed(2);
  process.stderr.write(
    `aadr: wrote ${OUT} — ${artifact.counts.total} individuals ` +
      `(${artifact.counts.ancient} ancient, ${artifact.counts.coords} with coordinates, ` +
      `${artifact.counts.y} with a Y haplogroup), ${mb} MB\n`,
  );
}

main().catch((e) => {
  process.stderr.write(`aadr: ${e.message}\n`);
  process.exit(1);
});
