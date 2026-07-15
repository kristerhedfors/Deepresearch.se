// Node tests for the Se/rver balloon intro's PURE core (balloon-intro.js):
// the timeline ramps, the 180° camera drop + sideways roll, the same-shape/
// different-sizes fleet contract, the projection/depth math — and the
// owner's "faster than the umbrella intro" directive, pinned as a fact.

import test from "node:test";
import assert from "node:assert/strict";

import {
  BASE_SPEED,
  EASTER_EGG_EVERY,
  EH_FRAC,
  FLEET,
  PROF_MAX,
  ROLL_END,
  ROLL_MAX,
  T,
  WIDTH,
  easterEggReverse,
  envelopeR,
  envelopeZ,
  goreDepth,
  paramsAt,
  projectPitch,
} from "./balloon-intro.js";
import { BASE_SPEED as UMBRELLA_SPEED, T as UMBRELLA_T } from "../cure/umbrella.js";

test("timeline: marks strictly ordered where the design requires it", () => {
  assert.ok(T.swirlEnd < T.untwistEnd);
  assert.ok(T.untwistEnd < T.wireEnd);
  assert.ok(T.wireEnd <= T.dropStart);
  assert.ok(T.dropStart < T.rollPeak && T.rollPeak < T.dropEnd);
  assert.ok(T.reviveStart > T.dropStart, "the revival happens ON the way down");
  assert.ok(T.reviveEnd < T.fadeStart);
  assert.ok(T.rigEnd < T.fadeStart);
  assert.ok(T.fadeStart < T.end);
});

test("FASTER than the umbrella intro (owner directive): real duration is shorter", () => {
  const real = T.end / BASE_SPEED;
  const umbrellaReal = UMBRELLA_T.end / UMBRELLA_SPEED;
  assert.ok(
    real < umbrellaReal,
    `balloon intro ${real}ms must beat umbrella ${umbrellaReal}ms`
  );
  assert.ok(real < 4500, `still a tight scene (${real}ms real)`);
});

test("paramsAt: the vortex opening — full twist, no wire, logo fill", () => {
  const P = paramsAt(0);
  assert.equal(P.twist, 1);
  assert.equal(P.wire, 0);
  assert.equal(P.fill, 1);
  assert.equal(P.cam, 0, "top view");
  assert.equal(P.roll, 0);
  assert.equal(P.revive, 0);
  assert.equal(P.done, false);
});

test("paramsAt: the camera drops a FULL 180° — cam ends at π (from below)", () => {
  assert.equal(paramsAt(T.dropStart).cam, 0);
  const mid = paramsAt((T.dropStart + T.dropEnd) / 2).cam;
  assert.ok(mid > 0 && mid < Math.PI);
  assert.equal(paramsAt(T.dropEnd).cam, Math.PI);
  assert.equal(paramsAt(T.end).cam, Math.PI, "stays underneath to the end");
  // Monotone descent, no bounce.
  let prev = -1;
  for (let t = T.dropStart; t <= T.dropEnd; t += 100) {
    const c = paramsAt(t).cam;
    assert.ok(c >= prev);
    prev = c;
  }
});

test("paramsAt: the sideways roll crests at rollPeak and settles into a lean", () => {
  assert.equal(paramsAt(T.dropStart).roll, 0);
  assert.ok(Math.abs(paramsAt(T.rollPeak).roll - ROLL_MAX) < 1e-9, "crest = ROLL_MAX");
  assert.ok(Math.abs(paramsAt(T.dropEnd).roll - ROLL_END) < 1e-9, "settles at ROLL_END");
  assert.ok(ROLL_END > 0, "the view ends leaning, not flat");
  assert.ok(ROLL_MAX > ROLL_END);
});

test("paramsAt: wire draws after the untwist; logo fill gone before the revival", () => {
  assert.equal(paramsAt(T.untwistEnd).twist, 0);
  assert.equal(paramsAt(T.wireEnd).wire, 1);
  assert.equal(paramsAt(T.fillGone).fill, 0);
  assert.equal(paramsAt(T.reviveStart).revive, 0, "loop apex is still colorless");
  assert.equal(paramsAt(T.reviveEnd).revive, 1);
  assert.equal(paramsAt(T.rigEnd).rig, 1);
  assert.equal(paramsAt(T.end).fade, 0);
  assert.equal(paramsAt(T.end).done, true);
});

test("fleet: five balloons, the SAME shape, different sizes (owner's call)", () => {
  assert.equal(FLEET.length, 5);
  const sizes = FLEET.map((u) => u.s);
  assert.equal(new Set(sizes).size, 5, "every size distinct");
  for (const u of FLEET) {
    // Same shape by construction: no per-balloon shape fields exist — the one
    // prof/WIDTH/EH_FRAC profile draws every envelope. Pin that contract.
    assert.equal(u.dome, undefined);
    assert.equal(u.pagoda, undefined);
    assert.equal(u.scallop, undefined);
    assert.ok(u.s > 0 && u.s < 1);
    assert.ok(u.fx >= 0 && u.fx <= 1 && u.fy >= 0 && u.fy <= 1);
    assert.match(u.col, /^#/);
    assert.match(u.alt, /^#/);
    assert.match(u.border, /^#/);
  }
  // Staggered arrivals, like the umbrella fleet.
  for (let i = 1; i < FLEET.length; i++) assert.ok(FLEET[i].delay > FLEET[i - 1].delay);
});

test("envelope: crown a point, bulge widest, mouth open; z spans ±EH/2", () => {
  const R = 100;
  assert.ok(envelopeR(0, R) < 6, "crown");
  const bulge = envelopeR(0.42, R);
  assert.ok(bulge > envelopeR(0.9, R) && bulge > envelopeR(0.1, R));
  assert.ok(envelopeR(1, R) > 8, "the mouth stays open for the burner");
  assert.equal(envelopeZ(0, R), (EH_FRAC / 2) * R);
  assert.equal(envelopeZ(1, R), -(EH_FRAC / 2) * R);
  assert.ok(PROF_MAX * WIDTH * R >= bulge, "PROF_MAX bounds the widest latitude");
});

test("projectPitch: top view shows the crown disc, from-below mirrors it", () => {
  const p = { x: 3, y: 4, z: 5 };
  const top = projectPitch(p, 0);
  assert.equal(top.x, 3);
  assert.equal(top.y, -4, "top view: screen y = -world y");
  assert.equal(top.d, 5, "top view: higher z is nearer");
  const below = projectPitch(p, Math.PI);
  assert.equal(below.x, 3);
  assert.ok(Math.abs(below.y - 4) < 1e-9, "from below: the scatter mirrors");
  assert.ok(Math.abs(below.d - -5) < 1e-9, "from below: LOWER z is nearer (the basket)");
  const side = projectPitch(p, Math.PI / 2);
  assert.ok(Math.abs(side.y - -5) < 1e-9, "side view: screen y = -z");
});

test("goreDepth: ties in both disc views, -y longitudes nearest at side view", () => {
  for (const th of [0, 1, 2, 4]) {
    assert.ok(Math.abs(goreDepth(th, 0)) < 1e-9, `top view ties (θ=${th})`);
    assert.ok(Math.abs(goreDepth(th, Math.PI)) < 1e-9, `bottom view ties (θ=${th})`);
  }
  const side = Math.PI / 2;
  assert.ok(goreDepth(-Math.PI / 2, side) > goreDepth(Math.PI / 2, side));
  assert.ok(goreDepth(0, side) === 0);
});

test("easter egg: every 40th play runs backwards, like the umbrella's", () => {
  assert.equal(EASTER_EGG_EVERY, 40);
  assert.equal(easterEggReverse(40), true);
  assert.equal(easterEggReverse(80), true);
  assert.equal(easterEggReverse(1), false);
  assert.equal(easterEggReverse(39), false);
  assert.equal(easterEggReverse(0), false);
  assert.equal(easterEggReverse(-40), false);
});
