// Node tests for the plant spinner's PURE side (plant-spinner.js): the growth
// timeline state (fall → plant → sprout, monotonic, growth reserved for the
// finale), the finale plan's speed-run buckets, and the green fleet cycling —
// mirroring the balloon/umbrella sibling contract (shared boomerang + finale
// pacing from umbrella-spinner.js).

import test from "node:test";
import assert from "node:assert/strict";

import {
  DROP_END,
  FULL_APEX,
  LOOP_APEX,
  PLANT_END,
  PLANT_FLEET,
  clamp01,
  planPlantFinale,
  plantFinaleBucket,
  plantPhaseAt,
  plantStateAt,
  smooth,
  spinnerStyle,
} from "./plant-spinner.js";
import { FINALE_CHECK_MS, FINALE_HOLD_MS, boomerangDesignTime } from "./umbrella-spinner.js";

test("timeline ordering: drop < plant < loop apex < full bloom", () => {
  assert.ok(DROP_END < PLANT_END);
  assert.ok(PLANT_END < LOOP_APEX);
  assert.ok(LOOP_APEX < FULL_APEX);
});

test("plantStateAt(0): a seed high above, nothing grown yet", () => {
  const S = plantStateAt(0);
  assert.equal(S.fall, 0);
  assert.equal(S.plantDepth, 0);
  assert.equal(S.stemH, 0);
  assert.equal(S.leafOpen, 0);
  assert.equal(S.trueLeaf, 0);
  assert.equal(S.bloom, 0);
});

test("plantStateAt: the seed has landed by the time it plants", () => {
  assert.equal(plantStateAt(DROP_END).fall, 1, "fully fallen at impact");
  assert.equal(plantStateAt(FULL_APEX).fall, 1);
});

test("LOOP_APEX: a settled sprout, growth NOT yet begun (reserved for done)", () => {
  const S = plantStateAt(LOOP_APEX);
  assert.equal(S.plantDepth, 1, "fully planted");
  assert.equal(S.leafOpen, 1, "cotyledons open");
  assert.ok(S.stemH > 0.2 && S.stemH < 0.3, "only a short sprout");
  assert.equal(S.trueLeaf, 0, "no true leaves in the loop");
  assert.equal(S.bloom, 0, "no bloom in the loop");
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
    for (const k of ["plantDepth", "stemH", "trueLeaf", "bloom"]) {
      assert.ok(S[k] >= prev[k] - 1e-9, `${k} decreased at t=${t}`);
    }
    prev = S;
  }
});

test("plantStateAt is total: garbage / out-of-range clamps, never throws", () => {
  assert.equal(plantStateAt(Number.NaN).stemH, 0);
  assert.equal(plantStateAt(-500).fall, 0);
  assert.equal(plantStateAt(FULL_APEX * 3).bloom, 1, "clamped to full");
});

test("plantPhaseAt: names each beat in order", () => {
  assert.equal(plantPhaseAt(0), "drop");
  assert.equal(plantPhaseAt(DROP_END + 10), "plant");
  assert.equal(plantPhaseAt(PLANT_END + 10), "sprout");
  assert.equal(plantPhaseAt(LOOP_APEX + 10), "grow");
  assert.equal(plantPhaseAt(FULL_APEX), "bloom");
  assert.equal(plantPhaseAt(Number.NaN), "drop", "defensive");
});

test("plantFinaleBucket: five buckets across the loop's beats", () => {
  assert.equal(plantFinaleBucket(0), 0);
  assert.equal(plantFinaleBucket(DROP_END), 1);
  assert.equal(plantFinaleBucket(PLANT_END), 2);
  assert.equal(plantFinaleBucket(1200), 3);
  assert.equal(plantFinaleBucket(LOOP_APEX), 4);
  assert.equal(plantFinaleBucket(Number.NaN), 0, "defensive");
});

test("planPlantFinale: grows from the caught position INTO full bloom", () => {
  for (const t0 of [0, DROP_END + 1, PLANT_END + 1, LOOP_APEX]) {
    const plan = planPlantFinale(t0);
    assert.equal(plan.runStart, t0);
    assert.equal(plan.runEnd, FULL_APEX);
    assert.ok(plan.runMs > 0);
    assert.equal(plan.holdMs, FINALE_HOLD_MS);
    assert.equal(plan.checkMs, FINALE_CHECK_MS);
    assert.equal(plan.totalMs, plan.runMs + plan.holdMs + plan.checkMs);
  }
  // Deeper along the loop → a shorter grow-out runway (a speed-run, not a snap).
  assert.ok(planPlantFinale(0).runMs > planPlantFinale(LOOP_APEX - 1).runMs);
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

test("shares the family's boomerang: the loop sweeps 0→apex→0, never grows", () => {
  const rate = 3;
  let maxT = 0;
  for (let ms = 0; ms < (4 * LOOP_APEX) / rate; ms += 16) {
    const t = boomerangDesignTime(ms, rate, LOOP_APEX);
    assert.ok(t >= 0 && t <= LOOP_APEX);
    assert.equal(plantStateAt(t).bloom, 0, "the loop never blooms");
    maxT = Math.max(maxT, t);
  }
  assert.ok(maxT > LOOP_APEX * 0.98, "the wave actually reaches the apex");
});

test("helpers: clamp01 / smooth are total", () => {
  assert.equal(clamp01(Number.NaN), 0);
  assert.equal(clamp01(-1), 0);
  assert.equal(clamp01(2), 1);
  assert.equal(smooth(0), 0);
  assert.equal(smooth(1), 1);
  assert.ok(smooth(0.5) > 0.4 && smooth(0.5) < 0.6);
});
