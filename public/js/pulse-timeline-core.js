// The pure core behind the FEATURE FOCUS TIMELINE — the maths that turns
// `/pulse/timeline.json` into something drawable, with no DOM and no fetch.
//
// Two surfaces render this dataset and they must not drift apart:
//
//   * `/pulse/timeline.html` — the full page: lines OR streamgraph, weigh by
//     commits OR lines changed, wheel/drag/brush zoom-and-pan, the curve
//     picker, a table fallback.
//   * `/welcome/` (the landing served at `/`) — a compact promo card under the
//     video: the same curves over the whole range, chips to turn a feature's
//     graph on and off, and a link through to the full page.
//
// Everything that decides WHAT a curve is — the time bucketing, the metric,
// the multi-tag split, the y-scale, the entity-stable colour lift for dark
// mode, which subjects are "the busiest six" — lives here and is unit-tested
// (`pulse-timeline-core.test.js`). Each page keeps only its own drawing and
// its own gestures. A second copy of the bucketing maths is exactly the drift
// this split exists to prevent, so add to the core rather than to a page.
//
// It lives under `public/js/` because the browser can only import served
// modules; nothing server-side re-exports it (no Worker path needs it).

export const HOUR = 3600e3;
export const DAY = 24 * HOUR;

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * @typedef {Object} RawCommit
 * @property {string} t   ISO timestamp carrying the CET/CEST offset
 * @property {number} [a] lines added
 * @property {number} [r] lines removed
 * @property {string[]} [s] subject keys this commit was tagged with (0..n)
 */

/**
 * @typedef {Object} Commit
 * @property {number} ms  wall-clock milliseconds
 * @property {number} a
 * @property {number} r
 * @property {string[]} s
 */

/**
 * Wall-clock ms from an ISO string that ALREADY carries the CET/CEST offset
 * (`scripts/pulse-time.mjs` normalises every timestamp before it is written).
 * The local components are read straight off the string rather than parsed as
 * an instant, so a commit buckets onto the same calendar day here as it does
 * on `/pulse` — regardless of the viewer's own timezone.
 *
 * @param {string} iso
 * @returns {number}
 */
export function wallMs(iso) {
  const y = +iso.slice(0, 4), mo = +iso.slice(5, 7) - 1, d = +iso.slice(8, 10);
  const h = +iso.slice(11, 13), mi = +iso.slice(14, 16), s = +iso.slice(17, 19);
  return Date.UTC(y, mo, d, h, mi, s);
}

/**
 * Dataset commits → the internal record, oldest first. Tolerates the missing
 * fields the builder omits for an untagged / binary-only commit.
 *
 * @param {RawCommit[]} [raw]
 * @returns {Commit[]}
 */
export function normalizeCommits(raw) {
  return (raw || [])
    .map((c) => ({ ms: wallMs(c.t), a: c.a || 0, r: c.r || 0, s: c.s || [] }))
    .sort((a, b) => a.ms - b.ms);
}

/**
 * The weight one commit contributes: a headcount, or the lines it churned.
 *
 * @param {Commit} c
 * @param {string} metric "commits" | "lines"
 * @returns {number}
 */
export function metricOf(c, metric) {
  return metric === "commits" ? 1 : c.a + c.r;
}

// ---- colour -------------------------------------------------------------
// The dataset carries one light-mode hex per subject. Dark mode lifts it
// toward white rather than substituting a different hue, so a subject's
// identity survives a theme switch (colours are entity-stable, never ranked).

const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const rgbToHex = (r) => "#" + r.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
const mix = (hex, target, t) => rgbToHex(hexToRgb(hex).map((c, i) => c + (target[i] - c) * t));

/**
 * @param {string} hex   the subject's registry colour
 * @param {boolean} dark whether the surface is currently dark
 * @returns {string}
 */
export function seriesColor(hex, dark) {
  return dark ? mix(hex, [255, 255, 255], 0.24) : hex;
}

// ---- bucketing ----------------------------------------------------------

/** Bucket widths, coarsening until the window holds a readable number. */
export const STEPS = [HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY];

/**
 * The widest step that keeps a `span`-long window under `maxBuckets` bins.
 *
 * @param {number} span milliseconds
 * @param {number} [maxBuckets]
 * @returns {number}
 */
export function pickStep(span, maxBuckets = 56) {
  for (const st of STEPS) if (span / st <= maxBuckets) return st;
  return STEPS[STEPS.length - 1];
}

/**
 * @typedef {Object} Bucket
 * @property {number} t0
 * @property {number} t1
 * @property {number} mid
 * @property {number} step
 * @property {Record<string, number>} per per-subject weight in this bin
 * @property {number} total
 * @property {number} untagged
 * @property {number} commits
 */

/**
 * Bucket every commit falling in [t0, t1] into fixed-width bins.
 *
 * Bins are aligned to the calendar day of `anchorMs` (the FULL range's start),
 * not to `t0` — so panning the window slides the data across a stable grid
 * instead of re-cutting it under the viewer.
 *
 * The two modes differ in how a commit tagged with several subjects is
 * counted, and the difference is deliberate: `"lines"` gives each of its tags
 * the FULL weight (overlap is fine — the chart is measuring attention, and a
 * commit really did touch all of them), while `"stream"` SPLITS the weight
 * across the tags so the stacked band still sums to the period's real total.
 *
 * @param {Commit[]} commits sorted oldest→newest
 * @param {number} t0
 * @param {number} t1
 * @param {{anchorMs: number, metric?: string, mode?: string, maxBuckets?: number}} opts
 * @returns {Bucket[]}
 */
export function buildBuckets(commits, t0, t1, opts) {
  const metric = opts.metric || "commits";
  const mode = opts.mode || "lines";
  const step = pickStep(t1 - t0, opts.maxBuckets);
  const anchor = Math.floor(opts.anchorMs / DAY) * DAY;
  const i0 = Math.floor((t0 - anchor) / step);
  const i1 = Math.floor((t1 - anchor) / step);
  /** @type {Bucket[]} */
  const buckets = [];
  for (let i = i0; i <= i1; i++) {
    const b0 = anchor + i * step;
    buckets.push({
      t0: b0, t1: b0 + step, mid: b0 + step / 2, step,
      per: Object.create(null), total: 0, untagged: 0, commits: 0,
    });
  }
  if (!buckets.length) return buckets;
  const first = buckets[0].t0, last = buckets[buckets.length - 1].t1;
  for (const c of commits) {
    if (c.ms < first || c.ms >= last) continue;
    const b = buckets[Math.floor((c.ms - anchor) / step) - i0];
    if (!b) continue;
    b.commits += 1;
    const v = metricOf(c, metric);
    b.total += v;
    if (!c.s.length) { b.untagged += v; continue; }
    const share = mode === "stream" ? v / c.s.length : v;
    for (const k of c.s) b.per[k] = (b.per[k] || 0) + share;
  }
  return buckets;
}

/**
 * The tallest value any drawn curve reaches in these buckets — per-series in
 * `"lines"` mode, the stack height in `"stream"` mode.
 *
 * @param {Bucket[]} buckets
 * @param {string[]} keys the subjects actually drawn
 * @param {string} [mode]
 * @returns {number}
 */
export function peakOf(buckets, keys, mode = "lines") {
  let ymax = 1;
  if (mode === "lines") {
    for (const b of buckets) for (const k of keys) ymax = Math.max(ymax, b.per[k] || 0);
  } else {
    for (const b of buckets) {
      let sum = 0;
      for (const k of keys) sum += b.per[k] || 0;
      ymax = Math.max(ymax, sum);
    }
  }
  return ymax;
}

/**
 * Round an axis maximum up to a human number (1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10
 * × a power of ten) so gridline labels read cleanly.
 *
 * @param {number} v
 * @returns {number}
 */
export function niceMax(v) {
  if (v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) { const c = m * pow; if (c >= v) return c; }
  return 10 * pow;
}

// ---- subject selection --------------------------------------------------

/**
 * The subjects worth offering at all: registry order, minus any the tagger
 * never matched (a taxonomy entry with no commits is a dead chip).
 *
 * @param {string[]} order registry order
 * @param {Record<string, {commits?: number, added?: number, removed?: number}>} byKey
 * @returns {string[]}
 */
export function activeKeys(order, byKey) {
  return order.filter((k) => (byKey?.[k]?.commits || 0) > 0);
}

/**
 * The `n` busiest subjects over the whole history, by the current metric.
 * Twenty-eight curves at once is unreadable, so this is what both surfaces
 * open on.
 *
 * @param {string[]} order
 * @param {Record<string, {commits?: number, added?: number, removed?: number}>} byKey
 * @param {string} metric "commits" | "lines"
 * @param {number} n
 * @returns {string[]}
 */
export function topKeys(order, byKey, metric, n) {
  const of = (k) => {
    const t = byKey?.[k] || {};
    return metric === "commits" ? (t.commits || 0) : ((t.added || 0) + (t.removed || 0));
  };
  return activeKeys(order, byKey)
    .sort((a, b) => of(b) - of(a))
    .slice(0, n);
}

/**
 * Per-subject totals within a window, at FULL weight (a commit touching N
 * subjects counts toward each — the same "attention, not a partition" reading
 * the lines mode uses). Feeds the chip counts and the table.
 *
 * @param {Commit[]} commits
 * @param {string[]} order
 * @param {number} t0
 * @param {number} t1
 * @param {string} metric
 * @returns {Map<string, {commits: number, val: number}>}
 */
export function seriesTotalsInWindow(commits, order, t0, t1, metric) {
  const out = new Map(order.map((k) => [k, { commits: 0, val: 0 }]));
  for (const c of commits) {
    if (c.ms < t0 || c.ms > t1) continue;
    const v = metricOf(c, metric);
    for (const k of c.s) {
      const o = out.get(k);
      if (o) { o.commits += 1; o.val += v; }
    }
  }
  return out;
}

// ---- drawing helpers (pure string/number maths, no DOM) ------------------

/** Escape a value for interpolation into markup. */
export function svgEscape(v) {
  return String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/**
 * The polyline for one subject across the buckets, as an SVG path `d`.
 *
 * @param {Bucket[]} buckets
 * @param {string} key
 * @param {(ms: number) => number} xOf
 * @param {(v: number) => number} yOf
 * @returns {string}
 */
export function linePath(buckets, key, xOf, yOf) {
  let d = "";
  buckets.forEach((b, i) => {
    d += (i ? "L" : "M") + xOf(b.mid).toFixed(1) + " " + yOf(b.per[key] || 0).toFixed(1) + " ";
  });
  return d;
}

/**
 * Push overlapping labels apart, then pull any that overflowed back inside.
 * Two sweeps: downward for the minimum gap, upward for the bottom clamp — so
 * a bunched set still fits between `top` and `bottom` without collisions.
 *
 * Mutates nothing: returns the input objects with a `ly` (label y) added.
 *
 * @template {{y: number, ly?: number}} T
 * @param {T[]} labels
 * @param {number} gap
 * @param {number} top
 * @param {number} bottom
 * @returns {T[]} sorted by position, each carrying `ly`
 */
export function declutterLabels(labels, gap, top, bottom) {
  const out = labels.slice().sort((a, b) => a.y - b.y);
  let prevY = -Infinity;
  for (const lab of out) {
    lab.ly = Math.max(lab.y, prevY + gap, top + 6);
    prevY = lab.ly;
  }
  let nextY = bottom + gap;
  for (let i = out.length - 1; i >= 0; i--) {
    out[i].ly = Math.min(out[i].ly, nextY - gap);
    nextY = out[i].ly;
  }
  return out;
}

/**
 * The gap that lets `n` labels share a plot of `height` without colliding,
 * capped at the comfortable default.
 *
 * @param {number} n
 * @param {number} height
 * @param {number} [max]
 * @returns {number}
 */
export function labelGap(n, height, max = 12) {
  return Math.min(max, (height - 6) / Math.max(1, n - 1));
}
