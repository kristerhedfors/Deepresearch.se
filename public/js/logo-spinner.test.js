// Node tests for the coin spinner's PURE side (logo-spinner.js): the spin
// clock, the settle buckets, the turn that must always end FACE-ON, and the
// sibling contract — the coin's landing uses the SAME run/hold/check pacing as
// the umbrella / balloon / plant finales rather than a second set of numbers.

import test from "node:test";
import assert from "node:assert/strict";

import {
  COIN_SETTLE_TURNS,
  COIN_SPIN_MS,
  COIN_TILT_DEG,
  coinLandingBucket,
  coinPhase,
  landingTurnDeg,
  mountLogoSpinner,
  planCoinLanding,
  spinAngleAt,
} from "./logo-spinner.js";
import { FINALE_CHECK_MS, FINALE_HOLD_MS, FINALE_RUN_MS } from "./umbrella-spinner.js";

test("the landed coin lies flat, seen from 30° above the surface", () => {
  // A horizontal disc viewed from elevation θ foreshortens by sin θ, and a
  // screen-plane disc under rotateX(a) foreshortens by cos a. 30° elevation is
  // therefore rotateX(60deg) — the one number the whole finale is aimed at, and
  // what css/app.css `coin-land`'s 100% stop must carry.
  assert.equal(COIN_TILT_DEG, 60);
  assert.ok(
    Math.abs(Math.cos((COIN_TILT_DEG * Math.PI) / 180) - Math.sin(Math.PI / 6)) < 1e-12,
  );
});

test("coinPhase wraps the revolution and never leaves [0,1)", () => {
  assert.equal(coinPhase(0), 0);
  assert.equal(coinPhase(COIN_SPIN_MS / 4), 0.25);
  assert.equal(coinPhase(COIN_SPIN_MS), 0); // a whole turn is back at the start
  assert.equal(coinPhase(COIN_SPIN_MS * 3.5), 0.5);
  for (const t of [0, 1, 17, 5_000, 1e9]) {
    const p = coinPhase(t);
    assert.ok(p >= 0 && p < 1, `phase out of range at ${t}: ${p}`);
  }
});

test("coinPhase / spinAngleAt are defensive about a garbage clock", () => {
  for (const bad of [NaN, -1, undefined, null, "x"]) {
    assert.equal(coinPhase(/** @type {any} */ (bad)), 0);
    assert.equal(spinAngleAt(/** @type {any} */ (bad)), 0);
  }
  assert.equal(coinPhase(500, 0), coinPhase(500, COIN_SPIN_MS)); // a 0 period falls back
  assert.equal(coinPhase(500, /** @type {any} */ ("nope")), coinPhase(500, COIN_SPIN_MS));
});

test("spinAngleAt walks the full circle once per revolution", () => {
  assert.equal(spinAngleAt(0), 0);
  assert.equal(spinAngleAt(COIN_SPIN_MS / 2), 180);
  assert.ok(spinAngleAt(COIN_SPIN_MS - 1) > 359);
  assert.equal(spinAngleAt(COIN_SPIN_MS + COIN_SPIN_MS / 4), 90);
});

test("the settle bucket climbs with the phase, five versions like its siblings", () => {
  assert.equal(coinLandingBucket(0), 0);
  assert.equal(coinLandingBucket(0.1), 0);
  assert.equal(coinLandingBucket(0.2), 1);
  assert.equal(coinLandingBucket(0.45), 2);
  assert.equal(coinLandingBucket(0.7), 3);
  assert.equal(coinLandingBucket(0.99), 4);
  assert.equal(coinLandingBucket(1), 4);
  // Out of range and garbage clamp rather than index past the runway table.
  for (const bad of [-3, 9, NaN, undefined]) {
    const b = coinLandingBucket(/** @type {any} */ (bad));
    assert.ok(b >= 0 && b < FINALE_RUN_MS.length);
  }
});

test("landingTurnDeg always ends the coin FACE-ON, never on its edge", () => {
  for (let p = 0; p < 1; p += 0.037) {
    const startDeg = p * 360;
    const end = startDeg + landingTurnDeg(p);
    // A whole number of turns from zero: cos(end) ≈ 1 — the face is toward the
    // viewer, which is the only rest position a coin has.
    assert.ok(Math.abs(Math.cos((end * Math.PI) / 180) - 1) < 1e-9, `edge-on at ${p}`);
    assert.ok(landingTurnDeg(p) >= COIN_SETTLE_TURNS * 360);
  }
  // Caught right at the face: nothing left of this revolution, just the settle.
  assert.equal(landingTurnDeg(1), COIN_SETTLE_TURNS * 360);
  // Caught right after it: a whole revolution more to go — the longest turn.
  assert.equal(landingTurnDeg(0), (COIN_SETTLE_TURNS + 1) * 360);
});

test("the further from face-on, the longer the runway — but never a longer TURN than one extra revolution", () => {
  const early = planCoinLanding(0.02); // face just left
  const late = planCoinLanding(0.95); // face nearly back
  assert.ok(early.runMs > late.runMs);
  assert.ok(early.turnDeg > late.turnDeg);
  assert.ok(early.turnDeg - late.turnDeg < 360);
});

test("sibling pacing: the coin borrows the shared finale run/hold/check", () => {
  for (const p of [0, 0.25, 0.5, 0.75, 1]) {
    const plan = planCoinLanding(p);
    assert.equal(plan.runMs, FINALE_RUN_MS[plan.bucket]);
    assert.equal(plan.holdMs, FINALE_HOLD_MS);
    assert.equal(plan.checkMs, FINALE_CHECK_MS);
    assert.equal(plan.totalMs, plan.runMs + plan.holdMs + plan.checkMs);
  }
});

test("planCoinLanding is total: garbage in still yields a playable plan", () => {
  for (const bad of [NaN, -2, 4, undefined, "x"]) {
    const plan = planCoinLanding(/** @type {any} */ (bad));
    assert.ok(Number.isFinite(plan.totalMs) && plan.totalMs > 0);
    assert.ok(plan.turnDeg > 0);
    assert.ok(plan.startPhase >= 0 && plan.startPhase <= 1);
  }
});

// ---- the DOM layer's fail-soft contract (no document here — that IS the case
// this spinner exists for) ------------------------------------------------------------

test("mountLogoSpinner off-DOM is a no-op handle that still fires the callback", () => {
  const handle = mountLogoSpinner(/** @type {any} */ (null));
  assert.equal(typeof handle.stop, "function");
  let fired = 0;
  handle.finish(() => fired++);
  assert.equal(fired, 1, "the ✓ must never depend on the decoration");
  handle.stop();
  handle.finish();
});
