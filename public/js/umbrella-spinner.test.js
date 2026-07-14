// The umbrella SPINNER's pure helpers (public/js/umbrella-spinner.js): the
// looping clock and the per-slot style rotation. The mount/draw layer is
// canvas DOM glue and stays live-verified, per the project convention (only
// the two exports below run outside a browser).
import test from "node:test";
import assert from "node:assert/strict";

import {
  boomerangDesignTime,
  boomerangFlip,
  FLIP_WINDOW,
  spinnerStyle,
  finalePhaseBucket,
  planFinale,
  LOOP_APEX,
  PINK_APEX,
} from "./umbrella-spinner.js";
import { T, FLEET, BASE_SPEED, paramsAt } from "../cure/umbrella.js";

test("boomerangDesignTime ramps 0→cycle→0 (a triangle wave)", () => {
  const c = 1000;
  // Rises linearly on the forward sweep.
  assert.equal(boomerangDesignTime(0, 1, c), 0);
  assert.equal(boomerangDesignTime(250, 1, c), 250);
  // Apex at the half-period.
  assert.equal(boomerangDesignTime(1000, 1, c), 1000);
  // Falls back on the rewind sweep — same design-time as on the way up.
  assert.equal(boomerangDesignTime(1250, 1, c), 750);
  assert.equal(boomerangDesignTime(1750, 1, c), 250);
  // Full period returns to 0, then repeats.
  assert.equal(boomerangDesignTime(2000, 1, c), 0);
  assert.equal(boomerangDesignTime(2250, 1, c), 250);
});

test("boomerangDesignTime stays within [0, cycle] and honors clockRate", () => {
  const c = T.fadeStart;
  for (let ms = 0; ms < 30000; ms += 137) {
    const t = boomerangDesignTime(ms, BASE_SPEED, c);
    assert.ok(t >= 0 && t <= c, `t=${t} out of [0, ${c}] at ${ms}ms`);
  }
  // clockRate scales the real→design mapping.
  assert.equal(boomerangDesignTime(100, 2, 1000), 200);
});

test("boomerangDesignTime clamps negatives", () => {
  assert.equal(boomerangDesignTime(-500, BASE_SPEED), 0);
});

test("boomerangFlip is a monotonic full-turn tumble, snap-free at the seam", () => {
  const c = 6000; // > 3×FLIP_WINDOW so the tumble spans the full FLIP_WINDOW
  const period = 2 * c;
  const fw = Math.min(FLIP_WINDOW, c / 3);
  // No tumble at mount, and flat through the whole build-up (before the apex).
  assert.equal(boomerangFlip(0, 1, c), 0);
  assert.equal(boomerangFlip(c - fw - 1, 1, c), 0);
  // Halfway through the apex somersault at the very apex.
  assert.ok(Math.abs(boomerangFlip(c, 1, c) - Math.PI / 2) < 1e-9);
  // A full 180° flip reached by the far edge of the apex window, then HELD
  // through the rewind (the umbrella returns flipped, not un-flipping).
  assert.ok(Math.abs(boomerangFlip(c + fw, 1, c) - Math.PI) < 1e-9);
  assert.ok(Math.abs(boomerangFlip(period - 2 * fw, 1, c) - Math.PI) < 1e-9);
  // The second 180° un-rolls to 2π by the seam — so cos/sin land back at 0.
  assert.ok(Math.abs(boomerangFlip(period - 1e-6, 1, c) - 2 * Math.PI) < 1e-3);
  // Monotonic (never reverses) within a period (pos=period wraps to 0).
  let prev = -1;
  for (let pos = 0; pos < period; pos += 25) {
    const f = boomerangFlip(pos, 1, c);
    assert.ok(f >= prev - 1e-9, `flip dipped at pos=${pos}`);
    prev = f;
  }
  // Seam is snap-free in the only thing the draw uses (cos of the angle): the
  // frame just before the period wrap matches the frame just after (pos≈0).
  const before = Math.cos(boomerangFlip(period - 1e-6, 1, c));
  const after = Math.cos(boomerangFlip(0, 1, c));
  assert.ok(Math.abs(before - after) < 1e-3, "cos jumps across the loop seam");
});

test("boomerangFlip honors clockRate and clamps negatives", () => {
  // clockRate scales real→design just like the boomerang clock.
  assert.equal(boomerangFlip(100, 2, 1000), boomerangFlip(200, 1, 1000));
  assert.equal(boomerangFlip(-500, BASE_SPEED), 0);
});

test("the loop boomerangs JUST BEFORE the pink — its default apex is colorless", () => {
  // The default cycle is LOOP_APEX (= T.reviveStart), so the in-progress loop
  // never reaches the pink revive: revive is exactly 0 across the whole sweep.
  assert.equal(LOOP_APEX, T.reviveStart);
  for (let ms = 0; ms < 40000; ms += 91) {
    const t = boomerangDesignTime(ms, BASE_SPEED); // default cycle
    assert.ok(t >= 0 && t <= LOOP_APEX, `t=${t} past the loop apex at ${ms}ms`);
    assert.equal(paramsAt(t).revive, 0, `pink leaked into the loop at t=${t}`);
  }
});

test("the finale target IS the fully-bloomed pink umbrella", () => {
  // PINK_APEX is past the loop apex, fully revived and fully decorated, but not
  // yet fading — the richest pink with its fringe hung.
  assert.ok(PINK_APEX > LOOP_APEX);
  const P = paramsAt(PINK_APEX);
  assert.equal(P.revive, 1, "fully revived (pink)");
  assert.equal(P.deco, 1, "fringe fully hung");
  assert.equal(P.fade, 1, "not yet fading");
});

test("finalePhaseBucket gives five versions across the wave", () => {
  // Deep vortex → tilted & wobbling, one bucket per phase the catch lands in.
  assert.equal(finalePhaseBucket(0), 0); // deep in the vortex
  assert.equal(finalePhaseBucket(T.swirlEnd), 1); // untwisting
  assert.equal(finalePhaseBucket(T.untwistEnd), 2); // wireframe
  assert.equal(finalePhaseBucket(T.wireEnd), 3); // color draining
  assert.equal(finalePhaseBucket(T.tiltStart), 4); // tilted & wobbling
  assert.equal(finalePhaseBucket(LOOP_APEX), 4); // still bucket 4 at the apex
  // Five distinct buckets exist and only five.
  const seen = new Set();
  for (let t = 0; t <= LOOP_APEX; t += 50) seen.add(finalePhaseBucket(t));
  assert.deepEqual([...seen].sort((a, b) => a - b), [0, 1, 2, 3, 4]);
  // Defensive against junk.
  assert.equal(finalePhaseBucket(-1), 0);
  assert.equal(finalePhaseBucket(NaN), 0);
});

test("planFinale speed-runs from the caught wave position up to the pink apex", () => {
  for (const t0 of [0, 1500, 5000, 7000, 9000, LOOP_APEX]) {
    const p = planFinale(t0);
    assert.equal(p.runStart, t0, "starts from where the wave was caught");
    assert.equal(p.runEnd, PINK_APEX, "always ends at the pink umbrella");
    assert.equal(p.bucket, finalePhaseBucket(t0));
    assert.ok(p.runMs > 0 && p.holdMs > 0 && p.checkMs > 0);
    assert.equal(p.totalMs, p.runMs + p.holdMs + p.checkMs);
  }
  // Further from the apex → a longer runway (the speed-run reads deliberate,
  // not a snap), so the deep-vortex catch gets more real time than the tilt one.
  assert.ok(planFinale(0).runMs > planFinale(LOOP_APEX).runMs);
});

test("planFinale is defensive and never overshoots the pink apex", () => {
  assert.equal(planFinale(NaN).runStart, 0);
  assert.equal(planFinale(-500).runStart, 0);
  // A t0 beyond the apex (shouldn't happen, but be safe) clamps to it.
  assert.equal(planFinale(PINK_APEX + 5000).runStart, PINK_APEX);
});

test("spinnerStyle cycles the fleet so adjacent slots differ", () => {
  for (let i = 0; i < FLEET.length; i++) {
    assert.strictEqual(spinnerStyle(i), FLEET[i]);
  }
  // Wraps around.
  assert.strictEqual(spinnerStyle(FLEET.length), FLEET[0]);
  assert.strictEqual(spinnerStyle(FLEET.length + 2), FLEET[2]);
  // Two "different-style" neighbors (the wiring passes 0, 3, 6, … mod 6) pick
  // distinct canopies with distinct colors.
  const a = spinnerStyle(0);
  const b = spinnerStyle(3);
  assert.notStrictEqual(a, b);
  assert.notEqual(a.col, b.col);
});

test("spinnerStyle is defensive about junk indices", () => {
  assert.strictEqual(spinnerStyle(-1), FLEET[FLEET.length - 1]);
  assert.strictEqual(spinnerStyle(NaN), FLEET[0]);
  assert.strictEqual(spinnerStyle(/** @type {any} */ (undefined)), FLEET[0]);
  assert.strictEqual(spinnerStyle(2.9), FLEET[2]); // truncates
});

test("every fleet style carries the pink/white revival fields the spinner draws", () => {
  for (const u of FLEET) {
    for (const key of ["col", "alt", "border"]) {
      assert.match(u[key], /^#[0-9a-f]{6}$/i, `${key} is a hex color`);
    }
    assert.ok(u.dome > 0 && u.dome < 1, "dome height fraction is sane");
    assert.ok(u.pagoda >= 0 && u.pagoda <= 1, "pagoda blend in range");
  }
});
