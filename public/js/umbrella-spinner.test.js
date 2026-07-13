// The umbrella SPINNER's pure helpers (public/js/umbrella-spinner.js): the
// looping clock and the per-slot style rotation. The mount/draw layer is
// canvas DOM glue and stays live-verified, per the project convention (only
// the two exports below run outside a browser).
import test from "node:test";
import assert from "node:assert/strict";

import { loopedDesignTime, spinnerStyle } from "./umbrella-spinner.js";
import { T, FLEET, BASE_SPEED } from "../cure/umbrella.js";

test("loopedDesignTime wraps the clock into [0, cycle)", () => {
  const rate = BASE_SPEED; // design-ms per real-ms
  // A tiny elapsed stays in the swirl phase.
  const early = loopedDesignTime(100, rate);
  assert.ok(early >= 0 && early < T.end);
  assert.ok(early < T.swirlEnd, "the first moments are still the swirl");
  // Exactly one design cycle of real time wraps back near 0.
  const oneCycleReal = T.end / rate;
  const wrapped = loopedDesignTime(oneCycleReal, rate);
  assert.ok(wrapped < 1e-6 || Math.abs(wrapped - T.end) < 1e-6);
  // Well past several cycles still lands inside the range.
  const late = loopedDesignTime(oneCycleReal * 3.5 + 123, rate);
  assert.ok(late >= 0 && late < T.end);
});

test("loopedDesignTime clamps negatives and honors a custom cycle", () => {
  assert.equal(loopedDesignTime(-500, BASE_SPEED), 0);
  const t = loopedDesignTime(1000, 1, 400); // real 1000ms, rate 1 → 1000 design
  assert.ok(t >= 0 && t < 400);
  assert.equal(t, 1000 % 400);
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
