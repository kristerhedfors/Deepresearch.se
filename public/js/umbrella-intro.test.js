// The DRC first-visit umbrella intro's PURE core (public/cure/umbrella.js):
// the phase timeline and the vortex→umbrella geometry. The canvas layer is
// DOM-only and stays live-verified, per the project convention.
import test from "node:test";
import assert from "node:assert/strict";

import {
  T,
  clamp01,
  smooth,
  paramsAt,
  PANELS,
  MAX_TWIST,
  SCALLOP_DEPTH,
  DOME_FRAC,
  twistOffset,
  scallopFactor,
  canopyZ,
  project,
  FLEET,
  BASE_SPEED,
  clampAnimMult,
} from "../cure/umbrella.js";

test("timeline marks are ordered and phases overlap only as designed", () => {
  assert.ok(T.swirlEnd < T.untwistEnd);
  assert.ok(T.untwistEnd < T.wireEnd);
  assert.ok(T.wireEnd <= T.fillGone);
  assert.ok(T.fillGone <= T.tiltStart);
  assert.ok(T.tiltStart < T.tiltEnd);
  assert.ok(T.tiltEnd < T.fadeStart);
  assert.ok(T.fadeStart < T.end);
  // The revival begins only after the logo color is fully gone (a real
  // wire-only beat), and the fringe ("the decorations in the end") unspools
  // after the color has begun flooding back.
  assert.ok(T.fillGone <= T.reviveStart);
  assert.ok(T.reviveStart < T.reviveEnd);
  assert.ok(T.reviveStart < T.decoStart);
  assert.ok(T.decoStart < T.decoEnd);
  assert.ok(T.decoEnd <= T.fadeStart);
});

test("swirl phase: full twist, full color, no wire, top-down camera", () => {
  for (const t of [0, 1500, T.swirlEnd]) {
    const p = paramsAt(t);
    assert.equal(p.twist, 1);
    assert.equal(p.fill, 1);
    assert.equal(p.wire, 0);
    assert.equal(p.revive, 0);
    assert.equal(p.deco, 0);
    assert.equal(p.cam, 0);
    assert.equal(p.shaft, 0);
    assert.equal(p.fade, 1);
    assert.equal(p.done, false);
  }
  // The size pulse is alive through the whole swirl.
  assert.equal(paramsAt(0).pulse, 1);
});

test("untwist end: arms straight, scallop fully grown, still colored", () => {
  const p = paramsAt(T.untwistEnd);
  assert.equal(p.twist, 0);
  assert.equal(p.scallop, 1);
  assert.equal(p.fill, 1); // color starts draining only mid-wire
  assert.equal(p.cam, 0);
});

test("wire end: contours fully drawn; color fully gone by fillGone", () => {
  assert.equal(paramsAt(T.wireEnd).wire, 1);
  assert.ok(paramsAt(T.wireEnd).fill < 1);
  assert.equal(paramsAt(T.fillGone).fill, 0);
  assert.equal(paramsAt(T.fillGone).pulse, 0);
});

test("revival: wire-only beat, then color floods back and fringe dangles", () => {
  // Between the logo color draining and the revival starting there is a real
  // wire-only window: no logo color, no revived color, no fringe.
  const gap = paramsAt((T.fillGone + T.reviveStart) / 2);
  assert.equal(gap.fill, 0);
  assert.equal(gap.revive, 0);
  assert.equal(gap.deco, 0);
  assert.ok(gap.wire === 1); // the wireframe is fully drawn by now

  // Color comes fully back by reviveEnd; fringe is still on its way in there.
  assert.equal(paramsAt(T.reviveStart).revive, 0);
  assert.ok(paramsAt((T.reviveStart + T.reviveEnd) / 2).revive > 0);
  assert.equal(paramsAt(T.reviveEnd).revive, 1);

  // The decorations arrive last and are fully hung by decoEnd.
  assert.equal(paramsAt(T.decoStart).deco, 0);
  assert.equal(paramsAt(T.decoEnd).deco, 1);
  // Revival is monotone up over the whole clock (color never un-blooms).
  let prev = 0,
    prevD = 0;
  for (let t = 0; t <= T.end; t += 50) {
    const p = paramsAt(t);
    assert.ok(p.revive >= prev - 1e-12, `revive fell at ${t}`);
    assert.ok(p.deco >= prevD - 1e-12, `deco fell at ${t}`);
    prev = p.revive;
    prevD = p.deco;
  }
});

test("Victorian canopy constants: deep scallop, tall dome, varied hues", () => {
  // Deeper than the default subtle scallop the logo eases through.
  assert.ok(SCALLOP_DEPTH > 0.085);
  // A domed pagoda silhouette, not a flat parasol.
  assert.ok(DOME_FRAC > 0.34);
  // Every umbrella wakes into its own hue, and they are genuinely spread out
  // (no two canopies share a color).
  const cols = FLEET.map((u) => u.col);
  assert.ok(cols.every((c) => /^#[0-9a-f]{6}$/i.test(c)), "well-formed hex");
  assert.equal(new Set(cols).size, cols.length, "all distinct");
});

test("tilt: camera sweeps exactly a quarter circle, shaft fades in", () => {
  assert.equal(paramsAt(T.tiltStart).cam, 0);
  const mid = paramsAt((T.tiltStart + T.tiltEnd) / 2);
  assert.ok(mid.cam > 0 && mid.cam < Math.PI / 2);
  assert.ok(mid.shaft > 0);
  const end = paramsAt(T.tiltEnd);
  assert.ok(Math.abs(end.cam - Math.PI / 2) < 1e-9);
  assert.equal(end.shaft, 1);
  assert.equal(end.fade, 1); // fade hasn't started at tilt end
});

test("fade and done", () => {
  assert.equal(paramsAt(T.end).fade, 0);
  assert.equal(paramsAt(T.end).done, true);
  assert.equal(paramsAt(T.end + 1000).done, true);
  assert.equal(paramsAt(T.fadeStart).done, false);
});

test("parameter monotonicity over the whole clock", () => {
  let prev = paramsAt(0);
  for (let t = 50; t <= T.end; t += 50) {
    const p = paramsAt(t);
    assert.ok(p.twist <= prev.twist + 1e-12, `twist rose at ${t}`);
    assert.ok(p.cam >= prev.cam - 1e-12, `cam fell at ${t}`);
    assert.ok(p.wire >= prev.wire - 1e-12, `wire fell at ${t}`);
    assert.ok(p.fill <= prev.fill + 1e-12, `fill rose at ${t}`);
    assert.ok(p.fade <= prev.fade + 1e-12, `fade rose at ${t}`);
    assert.ok(p.spinRate <= prev.spinRate + 1e-12, `spin sped up at ${t}`);
    prev = p;
  }
  // The spin never fully stops — umbrellas keep turning to the end.
  assert.ok(paramsAt(T.end).spinRate > 0.25);
});

test("speed: 2.5× base pace, admin multiplier clamped with 1 as the default", () => {
  assert.equal(BASE_SPEED, 2.5); // 2026-07-12 directive — the slider's center
  // Garbage and non-positives fall back to the default, never to a freeze.
  for (const bad of [undefined, null, "", "fast", NaN, 0, -3]) {
    assert.equal(clampAnimMult(bad), 1, `bad input ${String(bad)}`);
  }
  // Honest values pass through inside the clamp, numeric strings included.
  assert.equal(clampAnimMult(1), 1);
  assert.equal(clampAnimMult(0.5), 0.5);
  assert.equal(clampAnimMult("2"), 2);
  // The clamp matches src/config.js's server-side clamp: [0.25, 4].
  assert.equal(clampAnimMult(0.01), 0.25);
  assert.equal(clampAnimMult(99), 4);
  // Sanity of the wall-clock outcome: at the default multiplier the whole
  // scene now runs in under 6 s of real time.
  assert.ok(T.end / (BASE_SPEED * clampAnimMult(undefined)) < 6000);
});

test("smooth/clamp01 basics", () => {
  assert.equal(clamp01(-3), 0);
  assert.equal(clamp01(7), 1);
  assert.equal(smooth(0), 0);
  assert.equal(smooth(1), 1);
  assert.equal(smooth(0.5), 0.5);
  assert.ok(smooth(0.25) < 0.25); // ease-in
  assert.ok(smooth(0.75) > 0.75); // ease-out
});

test("twistOffset: zero at the center and at zero twist, max at the rim", () => {
  assert.equal(twistOffset(0, 1), 0);
  assert.equal(twistOffset(1, 0), 0);
  assert.equal(twistOffset(1, 1), MAX_TWIST);
  // Sub-linear in r: the curl concentrates toward the rim like the logo.
  assert.ok(twistOffset(0.5, 1) > 0.5 * MAX_TWIST);
  // Out-of-range radius is clamped, not extrapolated.
  assert.equal(twistOffset(2, 1), MAX_TWIST);
});

test("scallopFactor: flat at the ribs, dipping mid-panel, off at scallop 0", () => {
  assert.equal(scallopFactor(0, 1), 1);
  assert.equal(scallopFactor(1, 1), 1);
  assert.ok(scallopFactor(0.5, 1) < 1);
  assert.equal(scallopFactor(0.5, 0), 1);
  // Deeper scallop dips deeper.
  assert.ok(scallopFactor(0.5, 1, 0.2) < scallopFactor(0.5, 1, 0.05));
});

test("canopyZ: apex at the center, rim at zero, monotone dome", () => {
  assert.equal(canopyZ(0, 10), 10);
  assert.equal(canopyZ(1, 10), 0);
  assert.ok(canopyZ(0.5, 10) > canopyZ(0.9, 10));
});

test("project: top view shows the x/y plane, side view shows x/z", () => {
  const p = { x: 3, y: 5, z: 7 };
  const top = project(p, 0);
  assert.equal(top.x, 3);
  assert.equal(top.y, -5); // world y up = screen up (negative)
  const side = project(p, Math.PI / 2);
  assert.equal(side.x, 3);
  assert.ok(Math.abs(side.y - -7) < 1e-9); // world z up = screen up
});

test("the fleet is a real crowd: varied sizes, both spin directions", () => {
  assert.ok(FLEET.length >= 5);
  const sizes = FLEET.map((u) => u.s);
  assert.ok(Math.max(...sizes) / Math.min(...sizes) > 2, "size spread");
  assert.ok(FLEET.some((u) => u.dir === 1) && FLEET.some((u) => u.dir === -1));
  for (const u of FLEET) {
    assert.ok(u.fx > 0 && u.fx < 1 && u.fy > 0 && u.fy < 1);
    assert.ok(u.delay >= 0 && u.delay < T.swirlEnd / 2, "appears during swirl");
  }
  assert.equal(PANELS % 2, 0, "panels must alternate two colors evenly");
});
