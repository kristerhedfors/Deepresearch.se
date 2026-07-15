// The Se/rver balloon guide's PURE core (public/js/balloon.js — the umbrella
// convention: timeline/geometry math Node-tested, the DOM layer verified
// live). Pins the envelope profile, the hover/climb/pennant/flare params,
// and the swish-cloud crossing guarantees the draw loop relies on.

import test from "node:test";
import assert from "node:assert/strict";

import {
  FLARE_MS,
  GORES,
  PENNANT_MAX,
  RISE_MAX,
  RISE_STEP,
  bobY,
  clamp01,
  cloudPos,
  flareLevel,
  pennantCount,
  prof,
  riseOffset,
  smooth,
  swishClouds,
} from "./balloon.js";

test("module is import-safe outside a browser (no top-level DOM access)", () => {
  assert.equal(typeof prof, "function"); // importing above already proved it
  assert.equal(GORES, 8); // matches the logo vortex / umbrella panel count
});

test("clamp01/smooth: bounds and monotone easing", () => {
  assert.equal(clamp01(-3), 0);
  assert.equal(clamp01(9), 1);
  assert.equal(smooth(0), 0);
  assert.equal(smooth(1), 1);
  assert.ok(smooth(0.25) < smooth(0.5) && smooth(0.5) < smooth(0.75));
});

test("prof: narrow crown, bulge high, narrow-but-open neck", () => {
  assert.ok(prof(0) < 0.05, "crown is a point");
  const peak = prof(0.42);
  assert.ok(peak > 0.95 && peak < 1.15, `bulge ~1 radius, got ${peak}`);
  assert.ok(prof(0.42) > prof(0.9), "narrows toward the neck");
  const neck = prof(1);
  assert.ok(neck > 0.05 && neck < 0.2, "neck stays open for the burner");
  assert.equal(prof(2), prof(1), "input clamped");
});

test("bobY: bounded hover, phase-shiftable", () => {
  for (const t of [0, 500, 1234, 99999]) assert.ok(Math.abs(bobY(t)) <= 3.5);
  assert.notEqual(bobY(1000, 0), bobY(1000, Math.PI));
});

test("riseOffset: climbs per task, capped so the guide stays in its corner", () => {
  assert.equal(riseOffset(0), 0);
  assert.equal(riseOffset(1), RISE_STEP);
  assert.equal(riseOffset(2), RISE_STEP * 2);
  assert.equal(riseOffset(1000), RISE_MAX);
  assert.equal(riseOffset(-2), 0, "never below ground");
});

test("pennantCount: one flag per task, capped, floored", () => {
  assert.equal(pennantCount(0), 0);
  assert.equal(pennantCount(3), 3);
  assert.equal(pennantCount(500), PENNANT_MAX);
  assert.equal(pennantCount(2.9), 2);
  assert.equal(pennantCount(-1), 0);
});

test("flareLevel: full at the task, decayed to zero by FLARE_MS, never negative", () => {
  assert.equal(flareLevel(0), 1);
  assert.ok(flareLevel(FLARE_MS / 2) > 0 && flareLevel(FLARE_MS / 2) < 1);
  assert.equal(flareLevel(FLARE_MS), 0);
  assert.equal(flareLevel(FLARE_MS * 5), 0);
  assert.equal(flareLevel(-100), 0, "before any task there is no flare");
});

test("swishClouds: deterministic per seed, lanes/scales in range", () => {
  const a = swishClouds(5, 42);
  const b = swishClouds(5, 42);
  assert.deepEqual(a, b, "same seed → same burst");
  assert.notDeepEqual(swishClouds(5, 43), a, "different seed → different burst");
  assert.equal(a.length, 5);
  for (const c of a) {
    assert.ok(c.lane >= 0.1 && c.lane <= 0.9);
    assert.ok(c.scale >= 0.5 && c.scale <= 1.3);
    assert.ok(c.delay >= 0 && c.delay <= 0.3);
    assert.ok(c.speed >= 1 + c.delay, "speed guarantees the crossing completes");
  }
});

test("cloudPos: every cloud starts off-screen, crosses monotonically, and completes by p=1", () => {
  for (const c of swishClouds(8, 7)) {
    assert.equal(cloudPos(c, 0), -0.25, "waiting off one edge");
    let prev = -Infinity;
    for (let p = 0; p <= 1.001; p += 0.05) {
      const q = cloudPos(c, p);
      assert.ok(q >= prev, "monotone crossing");
      prev = q;
    }
    assert.equal(cloudPos(c, 1), 1.25, "fully crossed when the swish ends");
  }
});
