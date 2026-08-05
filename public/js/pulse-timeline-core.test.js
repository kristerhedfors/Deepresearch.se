// Unit tests for the feature-focus timeline's pure core
// (public/js/pulse-timeline-core.js) — the maths shared by the full page
// (/pulse/timeline.html) and the compact card on the landing (/welcome/).
//
// The bucketing rules pinned here are the ones a second copy would get subtly
// wrong: the day-aligned anchor, the half-open bin edge, and the deliberate
// difference between how the two modes count a commit tagged with several
// subjects (full weight each vs. split so the stack still sums).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  DAY,
  HOUR,
  activeKeys,
  buildBuckets,
  declutterLabels,
  labelGap,
  compactLines,
  linePath,
  metricOf,
  niceMax,
  normalizeCommits,
  normalizeVolume,
  peakOf,
  pickStep,
  seriesColor,
  seriesTotalsInWindow,
  svgEscape,
  topKeys,
  volumeAreaPath,
  volumeEdgePath,
  volumeTicks,
  wallMs,
} from "./pulse-timeline-core.js";

const iso = (s) => s; // readability at the call sites below

describe("wallMs / normalizeCommits", () => {
  test("reads the local components off a CET-offset ISO, not the instant", () => {
    // 13:54 CEST must bucket as 13:54 — NOT as the 11:54 UTC instant, or the
    // landing and /pulse would disagree about which day a commit landed on.
    assert.equal(wallMs("2026-07-04T13:54:06+02:00"), Date.UTC(2026, 6, 4, 13, 54, 6));
    assert.equal(wallMs("2026-01-09T00:30:00+01:00"), Date.UTC(2026, 0, 9, 0, 30, 0));
  });

  test("sorts oldest first and fills the fields the builder omits", () => {
    const out = normalizeCommits([
      { t: iso("2026-07-05T10:00:00+02:00"), a: 5, r: 1, s: ["sandbox"] },
      { t: iso("2026-07-04T10:00:00+02:00") },
    ]);
    assert.equal(out.length, 2);
    assert.ok(out[0].ms < out[1].ms, "oldest first");
    assert.deepEqual(out[0], { ms: wallMs("2026-07-04T10:00:00+02:00"), a: 0, r: 0, s: [] });
  });

  test("an empty or missing commit list is not an error", () => {
    assert.deepEqual(normalizeCommits(), []);
    assert.deepEqual(normalizeCommits([]), []);
  });
});

describe("metricOf", () => {
  const c = { ms: 0, a: 30, r: 12, s: [] };
  test("commits weighs one per commit; lines weighs the churn", () => {
    assert.equal(metricOf(c, "commits"), 1);
    assert.equal(metricOf(c, "lines"), 42);
  });
});

describe("pickStep", () => {
  test("coarsens until the window fits under the bucket cap", () => {
    assert.equal(pickStep(20 * HOUR), HOUR, "a day's window bins by the hour");
    assert.equal(pickStep(40 * DAY), DAY, "40 daily bins is still under the cap");
    assert.equal(pickStep(200 * DAY), 7 * DAY, "past ~4 months only weekly bins fit");
  });
  test("never returns a step past the widest one", () => {
    assert.equal(pickStep(10 * 365 * DAY), 7 * DAY);
  });
  test("a tighter cap picks a wider step", () => {
    assert.ok(pickStep(30 * DAY, 8) > pickStep(30 * DAY, 56));
  });
});

describe("buildBuckets", () => {
  const anchorMs = wallMs("2026-07-04T00:00:00+02:00");
  const commits = normalizeCommits([
    { t: "2026-07-04T09:00:00+02:00", a: 10, r: 0, s: ["sandbox"] },
    { t: "2026-07-04T09:30:00+02:00", a: 4, r: 2, s: ["sandbox", "pipeline"] },
    { t: "2026-07-04T11:00:00+02:00", a: 7, r: 0, s: [] },
  ]);

  test("bins align to the anchor's calendar day, not to the window start", () => {
    // A window opening at 09:17 must still cut its bins on the hour.
    const b = buildBuckets(commits, wallMs("2026-07-04T09:17:00+02:00"), wallMs("2026-07-04T11:30:00+02:00"), { anchorMs });
    assert.equal(b[0].step, HOUR);
    assert.equal((b[0].t0 - Math.floor(anchorMs / DAY) * DAY) % HOUR, 0);
  });

  test("counts commits, total weight and untagged churn per bin", () => {
    const b = buildBuckets(commits, anchorMs, wallMs("2026-07-04T12:00:00+02:00"), { anchorMs, metric: "lines" });
    const at = (h) => b.find((x) => x.t0 === wallMs(`2026-07-04T${String(h).padStart(2, "0")}:00:00+02:00`));
    assert.equal(at(9).commits, 2);
    assert.equal(at(9).total, 10 + 6);
    assert.equal(at(9).untagged, 0);
    assert.equal(at(11).commits, 1);
    assert.equal(at(11).untagged, 7, "an untagged commit still counts toward the bin's churn");
    assert.deepEqual(Object.keys(at(11).per), [], "…but contributes to no curve");
  });

  test("lines mode gives a multi-tag commit FULL weight to each of its tags", () => {
    const b = buildBuckets(commits, anchorMs, wallMs("2026-07-04T12:00:00+02:00"), { anchorMs, metric: "commits", mode: "lines" });
    const nine = b.find((x) => x.t0 === wallMs("2026-07-04T09:00:00+02:00"));
    assert.equal(nine.per.sandbox, 2, "both commits touched sandbox");
    assert.equal(nine.per.pipeline, 1);
  });

  test("stream mode SPLITS a multi-tag commit so the stack sums to the total", () => {
    const b = buildBuckets(commits, anchorMs, wallMs("2026-07-04T12:00:00+02:00"), { anchorMs, metric: "commits", mode: "stream" });
    const nine = b.find((x) => x.t0 === wallMs("2026-07-04T09:00:00+02:00"));
    assert.equal(nine.per.sandbox, 1.5, "1 (solo) + 0.5 (shared with pipeline)");
    assert.equal(nine.per.pipeline, 0.5);
    const stacked = nine.per.sandbox + nine.per.pipeline;
    assert.equal(stacked, nine.total - nine.untagged, "the band sums to the tagged total");
  });

  test("the bin edge is half-open, so a commit lands in exactly one bin", () => {
    const edge = normalizeCommits([{ t: "2026-07-04T10:00:00+02:00", s: ["sandbox"] }]);
    const b = buildBuckets(edge, anchorMs, wallMs("2026-07-04T12:00:00+02:00"), { anchorMs });
    const hit = b.filter((x) => x.commits > 0);
    assert.equal(hit.length, 1);
    assert.equal(hit[0].t0, wallMs("2026-07-04T10:00:00+02:00"), "[t0, t1) — the opener owns the instant");
  });

  test("commits outside the window are excluded", () => {
    const b = buildBuckets(commits, anchorMs, wallMs("2026-07-04T10:00:00+02:00"), { anchorMs });
    assert.equal(b.reduce((s, x) => s + x.commits, 0), 2, "the 11:00 commit is out of frame");
  });
});

describe("peakOf / niceMax", () => {
  const buckets = [
    { per: { a: 3, b: 4 } },
    { per: { a: 9, b: 1 } },
  ];
  test("lines mode peaks on the tallest single curve", () => {
    assert.equal(peakOf(buckets, ["a", "b"], "lines"), 9);
  });
  test("stream mode peaks on the tallest stack", () => {
    assert.equal(peakOf(buckets, ["a", "b"], "stream"), 10);
  });
  test("only the drawn curves count toward the peak", () => {
    assert.equal(peakOf(buckets, ["b"], "lines"), 4);
  });
  test("an empty selection still yields a usable axis", () => {
    assert.equal(peakOf(buckets, [], "lines"), 1);
    assert.equal(niceMax(0), 1);
  });
  test("rounds up to a readable axis maximum", () => {
    assert.equal(niceMax(9), 10);
    assert.equal(niceMax(11), 15);
    assert.equal(niceMax(230), 250);
    assert.ok(niceMax(7) >= 7);
  });
});

describe("activeKeys / topKeys", () => {
  const order = ["sandbox", "pipeline", "dead", "maps"];
  const byKey = {
    sandbox: { commits: 87, added: 19658, removed: 3147 },
    pipeline: { commits: 46, added: 17134, removed: 3029 },
    dead: { commits: 0, added: 0, removed: 0 },
    maps: { commits: 60, added: 500, removed: 100 },
  };

  test("a taxonomy entry the tagger never matched is not offered", () => {
    assert.deepEqual(activeKeys(order, byKey), ["sandbox", "pipeline", "maps"]);
  });

  test("top-by-commits and top-by-lines rank differently", () => {
    assert.deepEqual(topKeys(order, byKey, "commits", 2), ["sandbox", "maps"]);
    assert.deepEqual(topKeys(order, byKey, "lines", 2), ["sandbox", "pipeline"]);
  });

  test("asking for more than exist yields only the active ones", () => {
    assert.equal(topKeys(order, byKey, "commits", 99).length, 3);
  });

  test("a missing totals table degrades to an empty selection, not a throw", () => {
    assert.deepEqual(topKeys(order, undefined, "commits", 6), []);
    assert.deepEqual(activeKeys(order, undefined), []);
  });
});

describe("seriesTotalsInWindow", () => {
  const commits = normalizeCommits([
    { t: "2026-07-04T09:00:00+02:00", a: 10, r: 0, s: ["sandbox"] },
    { t: "2026-07-04T09:30:00+02:00", a: 4, r: 2, s: ["sandbox", "pipeline"] },
    { t: "2026-07-06T09:00:00+02:00", a: 1, r: 0, s: ["pipeline"] },
  ]);
  const order = ["sandbox", "pipeline"];

  test("counts a multi-tag commit toward each of its subjects at full weight", () => {
    const t = seriesTotalsInWindow(commits, order, wallMs("2026-07-04T00:00:00+02:00"), wallMs("2026-07-05T00:00:00+02:00"), "commits");
    assert.equal(t.get("sandbox").commits, 2);
    assert.equal(t.get("pipeline").commits, 1);
  });

  test("honours the window and the metric", () => {
    const full = [wallMs("2026-07-04T00:00:00+02:00"), wallMs("2026-07-07T00:00:00+02:00")];
    const t = seriesTotalsInWindow(commits, order, full[0], full[1], "lines");
    assert.equal(t.get("sandbox").val, 10 + 6);
    assert.equal(t.get("pipeline").val, 6 + 1);
    const narrow = seriesTotalsInWindow(commits, order, full[0], wallMs("2026-07-05T00:00:00+02:00"), "lines");
    assert.equal(narrow.get("pipeline").val, 6);
  });
});

describe("seriesColor", () => {
  test("light mode uses the registry hue verbatim", () => {
    assert.equal(seriesColor("#2a78d6", false), "#2a78d6");
  });
  test("dark mode lifts the same hue toward white rather than replacing it", () => {
    const lifted = seriesColor("#2a78d6", true);
    assert.notEqual(lifted, "#2a78d6");
    assert.match(lifted, /^#[0-9a-f]{6}$/);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(lifted.slice(i, i + 2), 16));
    assert.ok(r > 0x2a && g > 0x78 && b > 0xd6, "every channel moves toward white");
  });
  test("distinct subjects stay distinct after the lift", () => {
    assert.notEqual(seriesColor("#2a78d6", true), seriesColor("#008300", true));
  });
});

describe("linePath", () => {
  test("emits one move then lines, at the bucket midpoints", () => {
    const buckets = [{ mid: 0, per: { a: 1 } }, { mid: 10, per: {} }, { mid: 20, per: { a: 3 } }];
    const d = linePath(buckets, "a", (ms) => ms, (v) => 100 - v);
    assert.equal(d, "M0.0 99.0 L10.0 100.0 L20.0 97.0 ");
    assert.equal((d.match(/M/g) || []).length, 1, "a single subpath — no gaps");
  });
});

describe("declutterLabels / labelGap", () => {
  test("pushes colliding labels apart by at least the gap", () => {
    const out = declutterLabels([{ y: 50 }, { y: 51 }, { y: 52 }], 12, 0, 300);
    for (let i = 1; i < out.length; i++) {
      assert.ok(out[i].ly - out[i - 1].ly >= 12 - 1e-9, "minimum gap held");
    }
  });

  test("keeps an over-full set inside the plot", () => {
    const labels = Array.from({ length: 28 }, (_, i) => ({ y: 290 + i * 0.1 }));
    const gap = labelGap(labels.length, 300);
    const out = declutterLabels(labels, gap, 0, 300);
    assert.ok(out[0].ly >= 0, "nothing pushed above the plot top");
    assert.ok(out[out.length - 1].ly <= 300 + 1e-9, "nothing pushed below the axis");
  });

  test("the gap compresses only when the set would overflow", () => {
    assert.equal(labelGap(6, 300), 12, "a small set keeps the comfortable gap");
    assert.ok(labelGap(28, 300) < 12, "a full set compresses to fit");
  });

  test("a single label is left where it is", () => {
    const out = declutterLabels([{ y: 120 }], labelGap(1, 300), 0, 300);
    assert.equal(out[0].ly, 120);
  });
});

describe("the code-volume backdrop", () => {
  const RAW = {
    unit: "lines",
    days: [
      { d: "2026-07-04", t: "2026-07-04T23:10:00+02:00", lines: 3030, files: 14 },
      { d: "2026-07-06", t: "2026-07-06T21:00:00+02:00", lines: 18240, files: 90 },
      { d: "2026-07-05", t: "2026-07-05T22:00:00+02:00", lines: 9100, files: 51 },
    ],
  };

  test("normalizes to wall-clock points, oldest first", () => {
    const pts = normalizeVolume(RAW);
    assert.deepEqual(pts.map((p) => p.d), ["2026-07-04", "2026-07-05", "2026-07-06"]);
    assert.equal(pts[0].ms, wallMs("2026-07-04T23:10:00+02:00"),
      "the reading sits at its own commit's wall time, on the same axis as the curves");
    assert.equal(pts[2].lines, 18240);
  });

  test("a dataset built before the series existed draws no backdrop", () => {
    // The landing card must survive an older /pulse/timeline.json rather than
    // throwing on the front door.
    assert.deepEqual(normalizeVolume(undefined), []);
    assert.deepEqual(normalizeVolume({}), []);
    assert.deepEqual(normalizeVolume([{ d: "2026-07-04" }]), [], "a reading with no count is dropped");
  });

  test("accepts a bare array as well as the wrapper", () => {
    assert.equal(normalizeVolume(RAW.days).length, 3);
  });

  test("the area closes to the baseline and the edge does not", () => {
    const pts = normalizeVolume(RAW);
    const [t0, t1] = [pts[0].ms, pts[2].ms];
    const xOf = (ms) => ((ms - t0) / (t1 - t0)) * 100;
    const yOf = (v) => 200 - (v / 20000) * 100;
    const area = volumeAreaPath(pts, t0, t1, xOf, yOf, 200);
    const edge = volumeEdgePath(pts, t0, t1, xOf, yOf);
    assert.match(area, /^M0\.0 200\.0 L/, "starts on the baseline under the first reading");
    assert.match(area, /L100\.0 200\.0 Z$/, "and closes there under the last");
    assert.match(edge, /^M0\.0 /);
    assert.ok(!edge.includes("Z"), "the edge is a curve, not a shape");
    assert.equal((edge.match(/L/g) || []).length, 2, "one segment per later reading");
  });

  test("readings outside the window cannot stretch the shape", () => {
    const pts = normalizeVolume(RAW);
    const t0 = pts[1].ms, t1 = pts[2].ms;
    const edge = volumeEdgePath(pts, t0, t1, (ms) => ms, (v) => v);
    assert.equal((edge.match(/[ML]/g) || []).length, 2, "only the two readings inside the window");
  });

  test("fewer than two readings inside the window draws nothing", () => {
    const pts = normalizeVolume(RAW);
    assert.equal(volumeEdgePath(pts, pts[2].ms, pts[2].ms, (ms) => ms, (v) => v), "");
    assert.equal(volumeAreaPath(pts, pts[2].ms, pts[2].ms, (ms) => ms, (v) => v, 10), "");
  });

  test("the right-hand scale lands on round thousands", () => {
    const t = volumeTicks(293991);
    assert.equal(t.top, 300000, "the axis top is rounded up, not the raw reading");
    assert.deepEqual(t.values, [0, 100000, 200000, 300000]);
    assert.deepEqual(t.values.map(compactLines), ["0", "100k", "200k", "300k"]);
  });

  test("every scale stays between two and five intervals", () => {
    for (const peak of [420, 3030, 18240, 96000, 150000, 293991, 640000, 1250000]) {
      const t = volumeTicks(peak);
      const n = t.values.length - 1;
      assert.ok(n >= 2 && n <= 5, `${peak} produced ${n} interval(s)`);
      assert.ok(t.top >= peak, `${peak} must fit under the axis top ${t.top}`);
      assert.equal(t.values[t.values.length - 1], t.top);
    }
  });

  test("labels read in thousands, not in exact line counts", () => {
    assert.equal(compactLines(0), "0");
    assert.equal(compactLines(840), "840");
    assert.equal(compactLines(1500), "1.5k");
    assert.equal(compactLines(50000), "50k");
    assert.equal(compactLines(293991), "294k");
    assert.equal(compactLines(1250000), "1.3M");
  });
});

describe("svgEscape", () => {
  test("neutralises markup in a subject label", () => {
    assert.equal(svgEscape('<b>&"'), "&lt;b&gt;&amp;&quot;");
  });
});
