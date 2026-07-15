// Node tests for the balloon spinner's PURE side (balloon-spinner.js): the
// loop apex that never reaches the color, the finale plan's speed-run
// buckets, and the style cycling — plus the sibling contract with the
// umbrella spinner (shared boomerang math, mirrored plan shape).

import test from "node:test";
import assert from "node:assert/strict";

import {
  BLUE_APEX,
  LOOP_APEX,
  finalePhaseBucket,
  planFinale,
  spinnerStyle,
} from "./balloon-spinner.js";
import { FLEET, T, paramsAt } from "./balloon-intro.js";
import { boomerangDesignTime } from "./umbrella-spinner.js";

test("LOOP_APEX: the boomerang turns back exactly where the color would start", () => {
  assert.equal(LOOP_APEX, T.reviveStart);
  assert.equal(paramsAt(LOOP_APEX).revive, 0, "the loop never shows a colored balloon");
  assert.ok(paramsAt(LOOP_APEX).camP > 0, "…but it is already descending at the apex");
});

test("BLUE_APEX: the finale lands on the fully colored, fully rigged balloon", () => {
  assert.equal(BLUE_APEX, T.rigEnd);
  const P = paramsAt(BLUE_APEX);
  assert.equal(P.revive, 1);
  assert.equal(P.rig, 1);
  assert.ok(P.fade > 0.99, "before the timeline's own fade");
});

test("boomerang with this cycle: sweeps 0→apex→0 and never crosses the color", () => {
  const rate = 3;
  let maxT = 0;
  for (let ms = 0; ms < (4 * LOOP_APEX) / rate; ms += 16) {
    const t = boomerangDesignTime(ms, rate, LOOP_APEX);
    assert.ok(t >= 0 && t <= LOOP_APEX);
    maxT = Math.max(maxT, t);
  }
  assert.ok(maxT > LOOP_APEX * 0.98, "the wave actually reaches the apex");
});

test("finalePhaseBucket: five buckets across the loop's phases", () => {
  assert.equal(finalePhaseBucket(0), 0); // deep vortex
  assert.equal(finalePhaseBucket(T.swirlEnd), 1);
  assert.equal(finalePhaseBucket(T.untwistEnd), 2);
  assert.equal(finalePhaseBucket(T.wireEnd), 3);
  assert.equal(finalePhaseBucket(T.dropStart), 4); // descending, nearly there
  assert.equal(finalePhaseBucket(Number.NaN), 0, "defensive");
});

test("planFinale: runs from the caught position INTO the blue apex", () => {
  for (const t0 of [0, T.swirlEnd + 1, T.wireEnd + 1, LOOP_APEX]) {
    const plan = planFinale(t0);
    assert.equal(plan.runStart, t0);
    assert.equal(plan.runEnd, BLUE_APEX);
    assert.ok(plan.runMs > 0);
    assert.equal(plan.totalMs, plan.runMs + plan.holdMs + plan.checkMs);
  }
  // Deeper in the vortex → longer real runway (a speed-run, not a snap).
  assert.ok(planFinale(0).runMs > planFinale(T.dropStart).runMs);
  // Defensive: clamped into [0, BLUE_APEX].
  assert.equal(planFinale(-5).runStart, 0);
  assert.equal(planFinale(T.end * 2).runStart, BLUE_APEX);
  assert.equal(planFinale(Number.NaN).runStart, 0);
});

test("spinnerStyle: cycles the intro fleet so adjacent slots differ", () => {
  assert.equal(spinnerStyle(0), FLEET[0]);
  assert.equal(spinnerStyle(1), FLEET[1]);
  assert.equal(spinnerStyle(FLEET.length), FLEET[0], "wraps");
  assert.notEqual(spinnerStyle(0), spinnerStyle(1));
  assert.equal(spinnerStyle(-1), FLEET[FLEET.length - 1], "negative wraps");
  assert.equal(spinnerStyle(Number.NaN), FLEET[0], "defensive");
});
