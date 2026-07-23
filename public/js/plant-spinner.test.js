// Node tests for the plant spinner's PURE side (plant-spinner.js): the growth
// timeline state (fall → plant → sprout → grow → bloom, monotonic), the
// forward LIFE-CYCLE clock (the loop blooms and re-seeds — owner directive,
// 2026-07-23; no boomerang rewind), the finale plan's speed-run buckets, and
// the green fleet cycling — sibling contract (finale pacing) still shared
// with umbrella-spinner.js.

import test from "node:test";
import assert from "node:assert/strict";

import {
  BLOOM_HOLD_MS,
  CYCLE_END,
  DROP_END,
  FULL_APEX,
  LOOP_APEX,
  PLANT_END,
  PLANT_FLEET,
  REPLANT_AT,
  RELEASE_MS,
  clamp01,
  cycleDesignTime,
  cycleStateAt,
  planPlantFinale,
  plantFinaleBucket,
  plantPhaseAt,
  plantStateAt,
  smooth,
  spinnerStyle,
} from "./plant-spinner.js";
import { FINALE_CHECK_MS, FINALE_HOLD_MS } from "./umbrella-spinner.js";

test("timeline ordering: drop < plant < sprout < full bloom < cycle end", () => {
  assert.ok(DROP_END < PLANT_END);
  assert.ok(PLANT_END < LOOP_APEX);
  assert.ok(LOOP_APEX < FULL_APEX);
  assert.ok(FULL_APEX < CYCLE_END);
  assert.equal(CYCLE_END, FULL_APEX + BLOOM_HOLD_MS + RELEASE_MS);
  assert.equal(REPLANT_AT, DROP_END, "later generations resume at the landing");
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

test("LOOP_APEX (end of the sprout beat): a settled sprout, real growth ahead", () => {
  const S = plantStateAt(LOOP_APEX);
  assert.equal(S.plantDepth, 1, "fully planted");
  assert.equal(S.leafOpen, 1, "cotyledons open");
  assert.ok(S.stemH > 0.2 && S.stemH < 0.3, "only a short sprout");
  assert.equal(S.trueLeaf, 0, "true leaves haven't unfurled yet");
  assert.equal(S.bloom, 0, "the bloom hasn't opened yet");
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
  assert.equal(plantPhaseAt(FULL_APEX + BLOOM_HOLD_MS - 1), "bloom", "held bloom");
  assert.equal(plantPhaseAt(FULL_APEX + BLOOM_HOLD_MS), "release");
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

test("the loop is a forward life-cycle: it BLOOMS, then wraps to replant", () => {
  // First generation: strictly forward, all the way through full bloom.
  let sawBloom = false;
  let prev = -1;
  for (let e = 0; e < CYCLE_END; e += 16) {
    const ct = cycleDesignTime(e);
    assert.ok(ct >= prev, `first generation runs forward (e=${e})`);
    prev = ct;
    if (plantStateAt(cycleStateAt(ct).t).bloom >= 1) sawBloom = true;
  }
  assert.ok(sawBloom, "the loop reaches full bloom (no boomerang rewind)");
  // Later generations wrap into [REPLANT_AT, CYCLE_END): the released seed
  // has already fallen, so the sky-fall beat never replays.
  for (let e = CYCLE_END; e < CYCLE_END * 3; e += 16) {
    const ct = cycleDesignTime(e);
    assert.ok(ct >= REPLANT_AT && ct < CYCLE_END, `wrapped range at e=${e}`);
  }
  assert.equal(cycleDesignTime(CYCLE_END), REPLANT_AT, "the wrap lands exactly at replant");
  assert.equal(cycleDesignTime(Number.NaN), 0, "defensive");
  assert.equal(cycleDesignTime(-100), 0, "defensive");
});

test("cycleStateAt: the release hands the seed off to the next generation", () => {
  const releaseStart = FULL_APEX + BLOOM_HOLD_MS;
  // Growing and held bloom: no overlay yet.
  const grow = cycleStateAt(FULL_APEX - 10);
  assert.equal(grow.releasing, false);
  assert.equal(grow.seedDrop, 0);
  assert.equal(grow.wither, 0);
  const hold = cycleStateAt(releaseStart - 1);
  assert.equal(hold.t, FULL_APEX, "the growth ladder pins at full bloom");
  assert.equal(hold.releasing, false);
  // Release start: the seed lets go at the flower, the parent still whole.
  const start = cycleStateAt(releaseStart);
  assert.equal(start.releasing, true);
  assert.equal(start.seedDrop, 0);
  assert.equal(start.wither, 0);
  // End of the beat: the seed has landed, the parent is all but gone.
  const end = cycleStateAt(CYCLE_END - 1);
  assert.ok(end.seedDrop > 0.99, "seed down");
  assert.ok(end.wither > 0.95, "parent withered away — no pop at the wrap");
  // Both overlays are monotonic across the beat.
  let last = cycleStateAt(releaseStart);
  for (let ct = releaseStart; ct <= CYCLE_END; ct += 10) {
    const c = cycleStateAt(ct);
    assert.ok(c.seedDrop >= last.seedDrop - 1e-9, `seedDrop dipped at ${ct}`);
    assert.ok(c.wither >= last.wither - 1e-9, `wither dipped at ${ct}`);
    last = c;
  }
  // Total on garbage.
  assert.equal(cycleStateAt(Number.NaN).t, 0);
  assert.equal(cycleStateAt(-50).releasing, false);
});

test("helpers: clamp01 / smooth are total", () => {
  assert.equal(clamp01(Number.NaN), 0);
  assert.equal(clamp01(-1), 0);
  assert.equal(clamp01(2), 1);
  assert.equal(smooth(0), 0);
  assert.equal(smooth(1), 1);
  assert.ok(smooth(0.5) > 0.4 && smooth(0.5) < 0.6);
});
