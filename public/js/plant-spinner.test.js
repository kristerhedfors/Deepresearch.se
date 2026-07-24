// Node tests for the plant spinner's PURE side (plant-spinner.js): the growth
// timeline state (sprout → grow → bloom, monotonic, NO brown beats — owner
// directive, 2026-07-24: no seed drop, no soil), the sprout loop clock (grow
// to the 🌱 shape, sway, fade, regrow), the finale plan's speed-run buckets,
// the completion seed scatter, and the green fleet cycling — sibling contract
// (finale pacing) still shared with umbrella-spinner.js.

import test from "node:test";
import assert from "node:assert/strict";

import {
  CYCLE_END,
  FULL_APEX,
  PLANT_FLEET,
  SCATTER_SEEDS,
  SPROUT_APEX,
  SPROUT_FADE_MS,
  SPROUT_HOLD_MS,
  SPROUT_STEM,
  clamp01,
  cycleDesignTime,
  cycleStateAt,
  planPlantFinale,
  plantFinaleBucket,
  plantPhaseAt,
  plantStateAt,
  scatterSeedAt,
  smooth,
  spinnerStyle,
} from "./plant-spinner.js";
import { FINALE_CHECK_MS, FINALE_HOLD_MS } from "./umbrella-spinner.js";

test("timeline ordering: sprout apex < full bloom; the loop wraps past hold+fade", () => {
  assert.ok(SPROUT_APEX < FULL_APEX);
  assert.equal(CYCLE_END, SPROUT_APEX + SPROUT_HOLD_MS + SPROUT_FADE_MS);
  assert.ok(SPROUT_STEM > 0 && SPROUT_STEM < 1);
});

test("plantStateAt(0): nothing yet — the sprout appears from nothing", () => {
  const S = plantStateAt(0);
  assert.equal(S.stemH, 0);
  assert.equal(S.leafOpen, 0);
  assert.equal(S.trueLeaf, 0);
  assert.equal(S.bloom, 0);
});

test("SPROUT_APEX: the 🌱 shape — stem with both leaves open, no flower yet", () => {
  const S = plantStateAt(SPROUT_APEX);
  assert.equal(S.stemH, SPROUT_STEM, "the sprout-stage stem height");
  assert.equal(S.leafOpen, 1, "the emoji leaf pair is open");
  assert.equal(S.trueLeaf, 0, "true leaves belong to the finale fast-forward");
  assert.equal(S.bloom, 0, "the bloom belongs to the finale fast-forward");
});

test("plantStateAt(FULL_APEX): fully grown and in bloom", () => {
  const S = plantStateAt(FULL_APEX);
  assert.equal(S.stemH, 1);
  assert.equal(S.trueLeaf, 1);
  assert.equal(S.bloom, 1);
});

test("growth fields are monotonic non-decreasing across the whole timeline", () => {
  let prev = plantStateAt(0);
  for (let t = 20; t <= FULL_APEX; t += 20) {
    const S = plantStateAt(t);
    for (const k of ["stemH", "leafOpen", "trueLeaf", "bloom"]) {
      assert.ok(S[k] >= prev[k] - 1e-9, `${k} decreased at t=${t}`);
    }
    prev = S;
  }
});

test("plantStateAt is total: garbage / out-of-range clamps, never throws", () => {
  assert.equal(plantStateAt(Number.NaN).stemH, 0);
  assert.equal(plantStateAt(-500).stemH, 0);
  assert.equal(plantStateAt(FULL_APEX * 3).bloom, 1, "clamped to full");
});

test("plantPhaseAt: names each beat in order", () => {
  assert.equal(plantPhaseAt(0), "sprout");
  assert.equal(plantPhaseAt(SPROUT_APEX - 1), "sprout");
  assert.equal(plantPhaseAt(SPROUT_APEX + 10), "grow");
  assert.equal(plantPhaseAt(FULL_APEX), "bloom");
  assert.equal(plantPhaseAt(Number.NaN), "sprout", "defensive");
});

test("plantFinaleBucket: five buckets across the sprout's climb", () => {
  assert.equal(plantFinaleBucket(0), 0);
  assert.equal(plantFinaleBucket(SPROUT_APEX * 0.25), 1);
  assert.equal(plantFinaleBucket(SPROUT_APEX * 0.5), 2);
  assert.equal(plantFinaleBucket(SPROUT_APEX * 0.75), 3);
  assert.equal(plantFinaleBucket(SPROUT_APEX), 4);
  assert.equal(plantFinaleBucket(Number.NaN), 0, "defensive");
});

test("planPlantFinale: fast-forwards from the caught position INTO the flower", () => {
  for (const t0 of [0, SPROUT_APEX * 0.3, SPROUT_APEX * 0.6, SPROUT_APEX]) {
    const plan = planPlantFinale(t0);
    assert.equal(plan.runStart, t0);
    assert.equal(plan.runEnd, FULL_APEX);
    assert.ok(plan.runMs > 0);
    assert.equal(plan.holdMs, FINALE_HOLD_MS);
    assert.equal(plan.checkMs, FINALE_CHECK_MS);
    assert.equal(plan.totalMs, plan.runMs + plan.holdMs + plan.checkMs);
  }
  // Deeper along the loop → a shorter grow-out runway (a speed-run, not a snap).
  assert.ok(planPlantFinale(0).runMs > planPlantFinale(SPROUT_APEX).runMs);
  // Defensive: clamped into [0, FULL_APEX].
  assert.equal(planPlantFinale(-5).runStart, 0);
  assert.equal(planPlantFinale(FULL_APEX * 2).runStart, FULL_APEX);
  assert.equal(planPlantFinale(Number.NaN).runStart, 0);
});

test("spinnerStyle: cycles the green fleet so adjacent slots differ", () => {
  assert.equal(spinnerStyle(0), PLANT_FLEET[0]);
  assert.equal(spinnerStyle(1), PLANT_FLEET[1]);
  assert.equal(spinnerStyle(PLANT_FLEET.length), PLANT_FLEET[0], "wraps");
  assert.notEqual(spinnerStyle(0), spinnerStyle(1));
  assert.equal(spinnerStyle(-1), PLANT_FLEET[PLANT_FLEET.length - 1], "negative wraps");
  assert.equal(spinnerStyle(Number.NaN), PLANT_FLEET[0], "defensive");
});

test("no brown: every fleet color is green or gold, never a brown", () => {
  // Brown = a DARK muted warm (r > g > b at low brightness) — the old seed
  // (#8a6a3a-family) and soil (#6b4f2a) tints. Bright warm golds are fine.
  for (const s of PLANT_FLEET) {
    for (const key of ["leaf", "stem", "seed", "flower", "center"]) {
      const hex = s[key];
      assert.match(hex, /^#[0-9a-f]{6}$/i, `${key} is a 6-digit hex`);
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      const darkWarm = r > g && g > b && r < 200;
      assert.ok(!darkWarm, `${key} ${hex} is not a brown`);
    }
  }
});

test("the loop grows to the 🌱 shape, sways, fades, and regrows — every generation", () => {
  // Within one generation the growth time runs forward to the apex and pins.
  let prev = -1;
  for (let e = 0; e < CYCLE_END; e += 16) {
    const c = cycleStateAt(cycleDesignTime(e));
    assert.ok(c.t >= prev, `growth runs forward (e=${e})`);
    assert.ok(c.t <= SPROUT_APEX, "the loop never grows past the sprout shape");
    prev = c.t;
  }
  // The apex is reached, held un-faded, then faded out exactly by the wrap.
  assert.equal(cycleStateAt(SPROUT_APEX).t, SPROUT_APEX);
  assert.equal(cycleStateAt(SPROUT_APEX).fade, 0);
  assert.equal(cycleStateAt(SPROUT_APEX + SPROUT_HOLD_MS).fade, 0, "held visible");
  assert.equal(cycleStateAt(CYCLE_END).fade, 1, "gone at the wrap — no pop");
  // Every generation replays the same story from nothing.
  assert.equal(cycleDesignTime(CYCLE_END), 0, "the wrap restarts the growth");
  assert.equal(cycleDesignTime(CYCLE_END * 2 + 5), 5);
  assert.equal(cycleDesignTime(Number.NaN), 0, "defensive");
  assert.equal(cycleDesignTime(-100), 0, "defensive");
});

test("cycleStateAt: fade is monotonic across the fade beat and total on garbage", () => {
  let last = cycleStateAt(SPROUT_APEX + SPROUT_HOLD_MS);
  for (let ct = SPROUT_APEX + SPROUT_HOLD_MS; ct <= CYCLE_END; ct += 10) {
    const c = cycleStateAt(ct);
    assert.ok(c.fade >= last.fade - 1e-9, `fade dipped at ${ct}`);
    last = c;
  }
  assert.equal(cycleStateAt(Number.NaN).t, 0);
  assert.equal(cycleStateAt(-50).fade, 0);
});

test("scatterSeedAt: tiny seeds fall all over — staggered, spreading, landing", () => {
  // Before the scatter starts nothing shows.
  for (let i = 0; i < SCATTER_SEEDS; i++) {
    assert.equal(scatterSeedAt(i, 0).a, 0, `seed ${i} hidden at p=0`);
  }
  // Mid-scatter at least half the seeds are visible and midair.
  let midair = 0;
  for (let i = 0; i < SCATTER_SEEDS; i++) {
    const s = scatterSeedAt(i, 0.6);
    assert.ok(s.y >= 0 && s.y <= 1);
    assert.ok(s.x >= -1 && s.x <= 1);
    if (s.a > 0 && s.y < 1) midair++;
  }
  assert.ok(midair >= SCATTER_SEEDS / 2, "a real scatter, not a lone seed");
  // The seeds spread — not all on one side, not all on one column.
  const xs = Array.from({ length: SCATTER_SEEDS }, (_, i) => scatterSeedAt(i, 1).x);
  assert.ok(xs.some((x) => x > 0.1) && xs.some((x) => x < -0.1), "falls on both sides");
  // Fully scattered: every seed has landed and faded (the ✓ ends clean).
  for (let i = 0; i < SCATTER_SEEDS; i++) {
    const s = scatterSeedAt(i, 1);
    assert.equal(s.y, 1, `seed ${i} down`);
    assert.equal(s.a, 0, `seed ${i} faded on landing`);
  }
  // Per-seed fall is monotonic.
  for (let i = 0; i < SCATTER_SEEDS; i++) {
    let lastY = 0;
    for (let p = 0; p <= 1.0001; p += 0.05) {
      const s = scatterSeedAt(i, p);
      assert.ok(s.y >= lastY - 1e-9, `seed ${i} rose at p=${p}`);
      lastY = s.y;
    }
  }
  // Total on garbage.
  assert.equal(scatterSeedAt(Number.NaN, Number.NaN).a, 0);
  assert.equal(scatterSeedAt(-3, 2).y, 1, "clamped progress");
});

test("helpers: clamp01 / smooth are total", () => {
  assert.equal(clamp01(Number.NaN), 0);
  assert.equal(clamp01(-1), 0);
  assert.equal(clamp01(2), 1);
  assert.equal(smooth(0), 0);
  assert.equal(smooth(1), 1);
  assert.ok(smooth(0.5) > 0.4 && smooth(0.5) < 0.6);
});
