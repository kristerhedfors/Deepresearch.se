// The umbrella SPINNER's pure helpers (public/js/umbrella-spinner.js): the
// looping clock and the per-slot style rotation. The mount/draw layer is
// canvas DOM glue and stays live-verified, per the project convention (only
// the two exports below run outside a browser).
import test from "node:test";
import assert from "node:assert/strict";

import { boomerangDesignTime, spinnerStyle } from "./umbrella-spinner.js";
import { T, FLEET, BASE_SPEED } from "../cure/umbrella.js";

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
