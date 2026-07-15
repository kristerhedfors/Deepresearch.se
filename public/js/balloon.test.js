// The Se/rver balloon greeter's PURE core (public/js/balloon.js — the
// umbrella convention: timeline/geometry math Node-tested, the DOM layer
// verified live). Pins the envelope profile, the hover/climb/pennant/flare
// params, the swish-cloud crossing guarantees the draw loop relies on, and
// the first-visit greeter script/departure contract (owner directive
// 2026-07-15 round 4: no persistent figures — pointers once, then gone).

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEPART_MS,
  FLARE_MS,
  GORES,
  GREETER_LINES,
  LINE_MS,
  PENNANT_MAX,
  RISE_MAX,
  RISE_STEP,
  bobY,
  clamp01,
  cloudPos,
  departProgress,
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

test("greeter script: a couple of short pointer lines, one per tier, Se/cure named as the door", () => {
  // The whole point of the figure now is a FIRST-VISIT pointer — a short,
  // bounded script, not ambient decoration. Keep it tight: 1–3 lines, each
  // bubble-sized.
  assert.ok(GREETER_LINES.length >= 1 && GREETER_LINES.length <= 3);
  for (const line of GREETER_LINES) {
    assert.equal(typeof line, "string");
    assert.ok(line.length > 0 && line.length <= 160, `bubble-sized, got ${line.length}`);
  }
  // It must actually point somewhere: this tier by name, and the ghost
  // button as the door to the secure tier.
  assert.ok(GREETER_LINES.some((l) => l.includes("Se/rver")));
  assert.ok(GREETER_LINES.some((l) => l.includes("ghost") && l.includes("Se/cure")));
});

test("greeter timing: a bounded stay — lines plus departure, well under a minute", () => {
  const stay = GREETER_LINES.length * LINE_MS + DEPART_MS;
  assert.ok(stay > 0 && stay < 60_000, `transient by construction, got ${stay}ms`);
});

test("departProgress: starts grounded, monotone, complete by DEPART_MS, clamped after", () => {
  assert.equal(departProgress(0), 0);
  let prev = -Infinity;
  for (let t = 0; t <= DEPART_MS; t += DEPART_MS / 20) {
    const p = departProgress(t);
    assert.ok(p >= prev, "monotone climb-out");
    prev = p;
  }
  assert.equal(departProgress(DEPART_MS), 1, "gone when the transition ends");
  assert.equal(departProgress(DEPART_MS * 3), 1, "clamped past the end");
  assert.equal(departProgress(-50), 0, "clamped before the start");
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
