// Unit tests for the ancient-sample query core (public/js/aadr-core.js).
//
// Two halves. The first runs against a SYNTHETIC artifact so the filter
// semantics are pinned against data whose every value is visible here. The
// second runs against the COMMITTED artifact, because several of the bugs this
// file exists to prevent were only visible against the real corpus — a place
// string containing the ordinary word "above", a group label containing
// "possmisdated", the fact that "Samara" is simultaneously an oblast and the
// tail of a population label. A synthetic fixture would have passed every one
// of those.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  BP_ZERO,
  DEFAULT_RADIUS_KM,
  SAMPLES_LAYOUT,
  ancientSampleIntent,
  ancientSampleLeadIntent,
  centroid,
  haploMatches,
  haversineKm,
  matchEntities,
  parseDateWindow,
  parseSampleQuery,
  parseSamples,
  querySamples,
  sampleBlock,
  year,
} from "./aadr-core.js";

// ---- a synthetic corpus ----------------------------------------------------
// id  grp ctry place lat lon dtype dstart dmed dstop c14bp mt y sex snps cov pkg pub
const FIXTURE = {
  spec: "aadr-samples/1",
  layout: SAMPLES_LAYOUT,
  source: { name: "test" },
  counts: { total: 5, ancient: 4, modern: 1, coords: 5, dated: 4, mt: 3, y: 2 },
  dict: {
    group: ["Sweden_Gotland_PittedWare", "Russia_EBA_Yamnaya_Samara", "Ignore_Sweden_contam", "Sweden_Modern.DG"],
    country: ["Sweden", "Russia"],
    place: ["Gotland, Västerbjers", "Samara Oblast, Lopatino II", "Uppsala"],
    pkg: ["2020_TestStudy"],
    pub: ["TestStudy2020"],
  },
  packageDesc: { "2020_TestStudy": "A test package." },
  rows: [
    // Gotland, 2738 BCE, F, mt U5b2a2, 14.45×
    "GOT01\t0\t0\t0\t57500\t18500\t1\t-2800\t-2738\t-2700\t4200\tU5b2a2\t\t2\t1150000\t1445\t0\t0",
    // Samara, 2900 BCE, M, Y R1b1a1a2a, 5.32×
    "SAM01\t1\t1\t1\t53200\t50100\t2\t-2950\t-2900\t-2850\t\t\tR1b1a1a2a\t1\t996000\t532\t0\t0",
    // Uppsala, 1000 BCE, M, no haplogroups, 0.4×
    "UPP01\t0\t0\t2\t59860\t17650\t1\t-1100\t-1000\t-900\t2900\t\t\t1\t120000\t40\t0\t0",
    // Ignore_-flagged, otherwise a perfect Gotland match
    "BAD01\t2\t0\t0\t57500\t18500\t1\t-2800\t-2738\t-2700\t4200\tU5b2a2\t\t2\t900000\t900\t0\t0",
    // present-day reference individual
    "MOD01\t3\t0\t2\t59860\t17650\t3\t\t\t\t\tH1a\tI1\t1\t1150000\t2000\t0\t0",
  ].join("\n"),
};

const D = /** @type {any} */ (parseSamples(FIXTURE));

test("parseSamples", async (t) => {
  await t.test("reads every column into the right place", () => {
    assert.equal(D.n, 5);
    assert.equal(D.id[0], "GOT01");
    assert.equal(D.lat[0], 57.5);
    assert.equal(D.lon[0], 18.5);
    assert.equal(D.dmed[0], -2738);
    assert.equal(D.cov[0], 14.45);
    assert.equal(D.mt[0], "U5b2a2");
    assert.equal(D.y[1], "R1b1a1a2a");
    assert.equal(D.sex[0], 2);
  });

  await t.test("empty fields become NaN, not zero — a real difference", () => {
    // 0.0× coverage and "no coverage reported" must never collapse: one says
    // the library failed, the other says nobody wrote it down.
    assert.ok(Number.isNaN(D.cov[4]) === false);
    assert.ok(Number.isNaN(D.dmed[4]), "present-day individual has no date");
    assert.ok(Number.isNaN(D.c14bp[1]), "no radiocarbon date on a contextual sample");
  });

  await t.test("resolves the Ignore_ flag at parse time", () => {
    assert.equal(D.ignored[3], 1);
    assert.equal(D.ignored[0], 0);
  });

  await t.test("refuses an artifact it cannot read rather than throwing", () => {
    assert.equal(parseSamples(null), null);
    assert.equal(parseSamples({}), null);
    assert.equal(parseSamples({ layout: 999, rows: "x" }), null, "unknown layout is refused, not read shifted");
    assert.equal(parseSamples({ layout: SAMPLES_LAYOUT, rows: "" }), null);
  });
});

test("ancientSampleIntent", async (t) => {
  await t.test("fires on a sample query in either language", () => {
    for (const s of [
      "how many ancient individuals have haplogroup R1b",
      "list burials from the Bronze Age near Gotland",
      "which ancient samples are dated between 5000 and 4000 BP",
      "hur många forntida individer har haplogrupp U5",
      "visa gravar från bronsåldern nära Gotland",
      "vilka skelett är daterade mellan 5000 och 4000 år sedan",
    ]) assert.equal(ancientSampleIntent(s), true, s);
  });

  await t.test("fires on the dataset by name", () => {
    for (const s of ["what is in the AADR", "poseidon package for Rasmussen 2010", "vad är AADR"]) {
      assert.equal(ancientSampleIntent(s), true, s);
    }
  });

  await t.test("stays silent on a literature question about the same field", () => {
    // This is the split that matters: "how does ancient DNA degrade" is
    // answered better by Europe PMC than by a table of individuals.
    for (const s of [
      "how does ancient DNA degrade over time",
      "explain what deamination does to aDNA reads",
      "hur bryts forntida DNA ner",
    ]) assert.equal(ancientSampleIntent(s), false, s);
  });

  await t.test("stays silent on the ordinary question", () => {
    for (const s of ["what's the weather", "refactor this function", ""]) {
      assert.equal(ancientSampleIntent(s), false, s);
    }
  });

  await t.test("the lead tier needs the dataset named", () => {
    assert.equal(ancientSampleLeadIntent("what is in the AADR"), true);
    assert.equal(ancientSampleLeadIntent("how many ancient individuals have haplogroup R1b"), false);
  });
});

test("parseDateWindow", async (t) => {
  await t.test("BP converts against 1950, not against now", () => {
    const w = parseDateWindow("samples dated 5000-4000 BP");
    assert.equal(w.from, BP_ZERO - 5000);
    assert.equal(w.to, BP_ZERO - 4000);
  });

  await t.test("BCE and CE are signed years", () => {
    const bce = parseDateWindow("between 3000 and 1000 BC");
    assert.equal(bce.from, -3000);
    assert.equal(bce.to, -1000);
    const ce = parseDateWindow("between 200 and 800 AD");
    assert.equal(ce.from, 200);
    assert.equal(ce.to, 800);
  });

  await t.test("Swedish era markers and phrasings work — the \\b trap", () => {
    // `\b` is ASCII-only, so /\bäldre än/ never matches. These four failed
    // silently before the boundaries went Unicode-aware.
    const older = parseDateWindow("äldre än 3000 år");
    assert.equal(older.to, BP_ZERO - 3000);
    assert.equal(older.from, -Infinity);
    const range = parseDateWindow("mellan 5000 och 4000 f.Kr.");
    assert.equal(range.from, -5000);
    assert.equal(range.to, -4000);
    const younger = parseDateWindow("yngre än 2000 år sedan");
    assert.equal(younger.from, BP_ZERO - 2000);
    assert.equal(younger.to, Infinity);
    assert.ok(parseDateWindow("omkring 4000 f.Kr."));
  });

  await t.test("orders a range regardless of which end was written first", () => {
    // In BP the larger number is the OLDER date, so "5000-4000 BP" and
    // "4000-5000 BP" describe the same window.
    const a = parseDateWindow("5000-4000 BP");
    const b = parseDateWindow("4000-5000 BP");
    assert.deepEqual([a.from, a.to], [b.from, b.to]);
  });

  await t.test("an unstated era means BP — how the field states a date", () => {
    const w = parseDateWindow("between 5000 and 4000");
    assert.equal(w.from, BP_ZERO - 5000);
  });

  await t.test("returns null when no date was asked for", () => {
    assert.equal(parseDateWindow("samples from Gotland"), null);
    assert.equal(parseDateWindow(""), null);
  });
});

test("haversineKm", async (t) => {
  await t.test("measures a known distance", () => {
    // Uppsala → Gotland (Västerbjers) is a little over 250 km.
    const km = haversineKm(59.86, 17.65, 57.5, 18.5);
    assert.ok(km > 250 && km < 280, `${km}`);
  });
  await t.test("is zero for a point against itself", () => {
    assert.equal(Math.round(haversineKm(57.5, 18.5, 57.5, 18.5)), 0);
  });
});

test("haploMatches is a PREFIX match, one way only", async (t) => {
  await t.test("a deeper call answers a shallower ask", () => {
    assert.equal(haploMatches("R1b1a1a2a", "R1b"), true);
    assert.equal(haploMatches("U5b2a2", "U5"), true);
  });

  await t.test("a shallower call does NOT answer a deeper ask", () => {
    // The sample was never resolved that far; claiming it was is a fabricated
    // result, not a near miss.
    assert.equal(haploMatches("R1b", "R1b1a1a2a"), false);
  });

  await t.test("folds case on both sides", () => {
    assert.equal(haploMatches("r1b1a1a2a", "R1B"), true);
  });

  await t.test("an unrecorded haplogroup never matches an asked-for one", () => {
    assert.equal(haploMatches("", "R1b"), false);
  });

  await t.test("no prefix asked means no constraint", () => {
    assert.equal(haploMatches("", null), true);
  });
});

test("matchEntities", async (t) => {
  await t.test("resolves a place segment", () => {
    const e = matchEntities(D, "samples from Gotland");
    assert.equal(e.placeLabel, "gotland");
    assert.deepEqual(e.places, [0]);
  });

  await t.test("resolves a place named by its word inside a compound", () => {
    // Upstream records "Samara Oblast, Lopatino II"; people write "Samara".
    const e = matchEntities(D, "samples near Samara");
    assert.equal(e.placeLabel, "samara");
    assert.deepEqual(e.places, [1]);
  });

  await t.test("a lowercase ordinary word is not a place", () => {
    // "above" and "group" are words inside real place strings; matching them
    // as locations silently empties an unrelated query.
    assert.equal(matchEntities(D, "coverage above 1x").places, null);
    assert.equal(matchEntities(D, "with Y-haplogroup R1b").places, null);
  });

  await t.test("resolves a population label by SEGMENT, not substring", () => {
    assert.equal(matchEntities(D, "the Yamnaya samples").group, "yamnaya");
    // "dated" is a substring of a real label (`…possmisdated`) but not a
    // segment of one, and must not become a population filter.
    assert.equal(matchEntities(D, "samples dated to the Bronze Age").group, null);
  });

  await t.test("geography wins over an identically-named population label", () => {
    const e = matchEntities(D, "samples near Samara");
    assert.equal(e.group, null, "the population reading is dropped, not ANDed");
  });
});

test("centroid anchors on the corpus itself", async (t) => {
  await t.test("averages the samples recorded at a place", () => {
    const c = centroid(D, { places: [2] });
    assert.equal(c.n, 2);
    assert.equal(Math.round(c.lat * 100) / 100, 59.86);
  });

  await t.test("returns null when nothing there has coordinates", () => {
    assert.equal(centroid(D, { places: [999] }), null);
  });
});

test("parseSampleQuery", async (t) => {
  await t.test("reads a full structured query", () => {
    const q = parseSampleQuery(D, "ancient individuals within 300 km of Gotland dated 5000-4000 BP with Y-haplogroup R1b");
    assert.equal(q.near.km, 300);
    assert.equal(q.when.from, BP_ZERO - 5000);
    assert.equal(q.haplo.y, "R1b");
    assert.equal(q.ancientOnly, true);
  });

  await t.test("Swedish mil is 10 km", () => {
    const q = parseSampleQuery(D, "inom 20 mil från Gotland");
    assert.equal(q.near.km, 200);
  });

  await t.test('"near X" with no distance takes the default radius', () => {
    assert.equal(parseSampleQuery(D, "samples near Gotland").near.km, DEFAULT_RADIUS_KM);
  });

  await t.test("says so when a radius cannot be anchored", () => {
    const q = parseSampleQuery(D, "samples within 100 km of Timbuktu");
    assert.equal(q.near, null);
    assert.ok(q.notes.some((n) => n.includes("could not be anchored")), q.notes.join("|"));
  });

  await t.test("keeps the haplogroup label as written", () => {
    assert.equal(parseSampleQuery(D, "mtDNA haplogroup U5b").haplo.mt, "U5b");
    assert.equal(parseSampleQuery(D, "Y-haplogroup R1b").haplo.y, "R1b");
  });

  await t.test("never captures the connective word as the haplogroup", () => {
    // "mtDNA haplogroup U5" parsed to the haplogroup "HAPLOGROUP" while the
    // gap between the two was a lazy wildcard.
    for (const s of ["mtDNA haplogroup U5", "mt haplogroup U5", "mitochondrial haplogroup U5"]) {
      assert.equal(parseSampleQuery(D, s).haplo.mt, "U5", s);
    }
  });

  await t.test("an unqualified haplogroup matches EITHER tree", () => {
    // R is a valid label on both the Y and the mtDNA tree, so guessing is worse
    // than searching both.
    const q = parseSampleQuery(D, "individuals with haplogroup R1b");
    assert.equal(q.haplo.either, "R1b");
    assert.equal(q.haplo.y, null);
    assert.equal(q.haplo.mt, null);
  });

  await t.test("excludes present-day individuals unless asked for", () => {
    assert.equal(parseSampleQuery(D, "samples from Sweden").ancientOnly, true);
    assert.equal(parseSampleQuery(D, "present-day reference individuals from Sweden").ancientOnly, false);
    assert.equal(parseSampleQuery(D, "nutida referenspanel från Sverige").ancientOnly, false);
  });

  await t.test("reads sex, coverage, and the Ignore_ opt-in", () => {
    assert.equal(parseSampleQuery(D, "female individuals").sex, 2);
    assert.equal(parseSampleQuery(D, "kvinnliga individer").sex, 2);
    assert.equal(parseSampleQuery(D, "male individuals").sex, 1);
    assert.equal(parseSampleQuery(D, "coverage above 1x").minCoverage, 1);
    assert.equal(parseSampleQuery(D, "täckning över 2.5").minCoverage, 2.5);
    assert.equal(parseSampleQuery(D, "including contaminated samples").includeIgnored, true);
  });

  await t.test("records what it understood, in words", () => {
    const q = parseSampleQuery(D, "female individuals near Gotland with coverage above 1x");
    assert.ok(q.notes.length >= 3, q.notes.join("|"));
  });
});

test("querySamples", async (t) => {
  await t.test("excludes Ignore_-flagged individuals by default and counts them", () => {
    const q = parseSampleQuery(D, "samples from Gotland");
    const r = querySamples(D, q);
    assert.equal(r.rows.map((i) => D.id[i]).includes("BAD01"), false);
    assert.ok(r.ignoredSkipped >= 1);
  });

  await t.test("includes them when explicitly asked", () => {
    const q = parseSampleQuery(D, "samples from Gotland including contaminated ones");
    const r = querySamples(D, q);
    assert.ok(r.rows.map((i) => D.id[i]).includes("BAD01"));
  });

  await t.test("excludes present-day individuals from an undated query", () => {
    const r = querySamples(D, parseSampleQuery(D, "individuals from Uppsala"));
    assert.equal(r.rows.map((i) => D.id[i]).includes("MOD01"), false);
  });

  await t.test("matches a date INTERVAL by overlap, not by its midpoint", () => {
    // GOT01 spans 2800–2700 BCE. A window touching only its edge still matches.
    const q = parseSampleQuery(D, "samples dated between 2710 and 2705 BC");
    const r = querySamples(D, q);
    assert.ok(r.rows.map((i) => D.id[i]).includes("GOT01"));
  });

  await t.test("counts undated individuals as untested rather than as misses", () => {
    const r = querySamples(D, parseSampleQuery(D, "samples dated 5000-4000 BP"));
    assert.ok(typeof r.undatedSkipped === "number");
  });

  await t.test("applies a radius against real distance", () => {
    const near = querySamples(D, parseSampleQuery(D, "samples within 50 km of Gotland"));
    assert.deepEqual(near.rows.map((i) => D.id[i]), ["GOT01"]);
    const far = querySamples(D, parseSampleQuery(D, "samples within 400 km of Gotland"));
    assert.ok(far.rows.map((i) => D.id[i]).includes("UPP01"), "Uppsala is ~260 km from Gotland");
  });

  await t.test("ranks by coverage — what a reader can actually use", () => {
    const r = querySamples(D, parseSampleQuery(D, "individuals from Sweden"));
    const covs = r.rows.map((i) => (Number.isNaN(D.cov[i]) ? -1 : D.cov[i]));
    assert.deepEqual(covs, [...covs].sort((a, b) => b - a));
  });

  await t.test("caps the returned rows but reports the true total", () => {
    const r = querySamples(D, parseSampleQuery(D, "individuals from Sweden"), { limit: 1 });
    assert.equal(r.rows.length, 1);
    assert.ok(r.total > 1);
  });
});

test("sampleBlock", async (t) => {
  await t.test("states the corpus, the filters and the exact count", () => {
    const q = parseSampleQuery(D, "samples from Gotland");
    const block = sampleBlock(D, q, querySamples(D, q));
    assert.ok(block.includes("ANCIENT-SAMPLE DATABASE"));
    assert.ok(block.includes("Filters applied:"));
    assert.ok(/Matched: \d+ individual/.test(block));
    assert.ok(block.includes("GOT01"));
  });

  await t.test("declares the Ignore_ exclusion in the block itself", () => {
    const q = parseSampleQuery(D, "samples from Gotland");
    const block = sampleBlock(D, q, querySamples(D, q));
    assert.ok(block.includes("Ignore_"));
  });

  await t.test("tells the model to say nothing matched rather than substitute", () => {
    const q = parseSampleQuery(D, "samples with Y-haplogroup Z99");
    const block = sampleBlock(D, q, querySamples(D, q));
    assert.ok(block.includes("NO ROWS MATCHED"));
    assert.ok(block.includes("rather than substituting remembered samples"));
  });

  await t.test("carries the caveats that decide whether a claim holds", () => {
    const q = parseSampleQuery(D, "samples from Gotland");
    const block = sampleBlock(D, q, querySamples(D, q));
    assert.ok(block.includes("absence of published data"));
    assert.ok(block.includes("not f-statistics, qpAdm or PCA"));
  });
});

test("year", () => {
  assert.equal(year(-2738), "2738 BCE");
  assert.equal(year(800), "800 CE");
  assert.equal(year(NaN), "");
});

// ---- against the committed corpus ------------------------------------------

test("the committed artifact", async (t) => {
  const real = parseSamples(JSON.parse(readFileSync("public/aadr/samples.tsv.json", "utf8")));

  await t.test("parses, and carries the fields the block reports", () => {
    assert.ok(real, "public/aadr/samples.tsv.json parses at the layout this core knows");
    assert.ok(real.n > 10000, `only ${real.n} individuals`);
    assert.equal(real.n, real.counts.total);
    assert.ok(real.counts.ancient > 0 && real.counts.modern > 0);
  });

  await t.test("Swedish place names survived the upstream mojibake", () => {
    // Poseidon serves double-encoded UTF-8 ("VÃ¤sterbjers"); the build repairs
    // it. Without the repair every Swedish site name is unsearchable in Swedish.
    assert.ok(real.placeSeg.has("västerbjers"), "Västerbjers is indexed under its real spelling");
    assert.equal(real.placeSeg.has("vã¤sterbjers"), false);
  });

  await t.test("a real structured query returns real individuals", () => {
    const q = parseSampleQuery(real, "how many Yamnaya individuals have Y-haplogroup R1b");
    const r = querySamples(real, q);
    assert.ok(r.total > 5, `${r.total} matches`);
    for (const i of r.rows) {
      assert.ok(real.y[i].toUpperCase().startsWith("R1B"), real.y[i]);
      assert.ok((real.dict.group[real.grp[i]] || "").toLowerCase().includes("yamnaya"));
    }
  });

  await t.test("an ordinary word inside a place string is not a location", () => {
    // Regression: "coverage above 1x" resolved "above" as a place, which
    // suppressed the country filter and answered a Greenland question about
    // nowhere.
    const q = parseSampleQuery(real, "ancient genomes from Greenland with coverage above 1x");
    assert.equal(q.places, null);
    assert.ok(q.country !== null, "the country filter survives");
    assert.ok(querySamples(real, q).total > 0);
  });

  await t.test("a Swedish proximity query works end to end", () => {
    const q = parseSampleQuery(real, "vilka forntida individer finns inom 20 mil från Gotland, äldre än 3000 år?");
    assert.equal(q.near.km, 200);
    assert.ok(q.when, "the Swedish date clause parsed");
    assert.ok(querySamples(real, q).total > 0);
  });

  await t.test("stays well inside a request's budget", () => {
    const started = Date.now();
    const q = parseSampleQuery(real, "ancient individuals within 500 km of Samara dated 5000-4000 BP");
    querySamples(real, q);
    assert.ok(Date.now() - started < 500, "a query over the whole corpus is milliseconds, not seconds");
  });
});
