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
  twistOffset,
  scallopFactor,
  canopyZ,
  project,
  FLEET,
  BASE_SPEED,
  clampAnimMult,
  CAPTIONS,
  CAPTION_FADE,
  captionAt,
} from "../cure/umbrella.js";

test("timeline marks are ordered and phases overlap only as designed", () => {
  assert.ok(T.swirlEnd < T.untwistEnd);
  assert.ok(T.untwistEnd < T.wireEnd);
  assert.ok(T.wireEnd <= T.fillGone);
  assert.ok(T.fillGone <= T.tiltStart);
  assert.ok(T.tiltStart < T.tiltEnd);
  assert.ok(T.tiltEnd < T.fadeStart);
  assert.ok(T.fadeStart < T.end);
});

test("swirl phase: full twist, full color, no wire, top-down camera", () => {
  for (const t of [0, 1500, T.swirlEnd]) {
    const p = paramsAt(t);
    assert.equal(p.twist, 1);
    assert.equal(p.fill, 1);
    assert.equal(p.wire, 0);
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

test("captions tell the trust-boundary story, in order, without overlap", () => {
  // The 2026-07-12 directive: the animation carries the boundary framing —
  // one external dataflow, provider named (OpenAI/Berget/local), the rest
  // verifiable code — not privacy superlatives.
  const all = CAPTIONS.map((c) => c.text).join(" | ");
  assert.match(all, /one external dataflow/);
  assert.match(all, /OpenAI, Berget, or your own local endpoint/);
  assert.match(all, /verifiable code/);
  assert.match(all, /pinch the reasoning/); // the hand-off to the depth view
  assert.equal(/private|privacy|secret/i.test(all), false, "no privacy superlatives");
  for (let i = 0; i < CAPTIONS.length; i++) {
    const c = CAPTIONS[i];
    assert.ok(c.to - c.from > 2 * CAPTION_FADE, `caption ${i} has room to fade`);
    if (i) assert.ok(c.from > CAPTIONS[i - 1].to, `caption ${i} starts after ${i - 1} ends`);
  }
  // All inside the visible timeline — nothing plays over the fade-out.
  assert.ok(CAPTIONS[0].from >= 0);
  assert.ok(CAPTIONS.at(-1).to <= T.fadeStart);
});

test("captionAt fades each line in and out, and is null between windows", () => {
  const c0 = CAPTIONS[0];
  assert.equal(captionAt(c0.from).alpha, 0);
  assert.equal(captionAt(c0.from + CAPTION_FADE).alpha, 1);
  assert.equal(captionAt(c0.to).alpha, 0);
  assert.equal(captionAt((c0.from + c0.to) / 2).text, c0.text);
  // Mid-fade is strictly between 0 and 1.
  const mid = captionAt(c0.from + CAPTION_FADE / 2).alpha;
  assert.ok(mid > 0 && mid < 1);
  // The gap between captions 0 and 1 shows nothing.
  assert.equal(captionAt((CAPTIONS[0].to + CAPTIONS[1].from) / 2), null);
  assert.equal(captionAt(T.end), null);
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
