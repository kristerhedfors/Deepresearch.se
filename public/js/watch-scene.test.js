// The watch builder's SCENE table (feedback #59: "reflections still look odd,
// possibly because of the all black background").
//
// The renderer has no scene geometry, so a scene is entirely numbers: the
// canvas clear colour on one side and the environment every metal reflects on
// the other. The bug those numbers encode is that the two were authored in
// different places and drifted apart — near-black behind the watch, mid-grey
// inside its reflections. What this file pins is therefore not "the colours
// are pretty" but the two structural facts that stop that recurring:
// `studio-dark` is byte-identical to the pre-#59 look, and every other scene's
// background is DERIVED from its own environment rather than typed in.
//
// The DEFAULT moved to `studio-grey` once the toggle had been measured (owner
// call). The pixel-identity property did not move with it — it belongs to
// `studio-dark` the scene, not to whichever scene happens to be first, so it
// is pinned here by name. What position 0 is pinned for is only what position
// 0 actually decides: which scene a device with no stored choice gets.
//
// The renderer itself cannot be imported here (it needs a GL context on the
// first line), so the render-side wiring — that these values reach uSky,
// uGround, uScene and gl.clearColor — is verified in a browser instead, with
// tests/verify-watch.mjs. Both halves are needed; neither substitutes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  LUME_SCENE,
  SCENES,
  sceneBackdrop,
  sceneFor,
  toneMap,
} from "./watch-materials.js";

const RENDER_SRC = readFileSync(new URL("./watch-render.js", import.meta.url), "utf8");

// ---------------------------------------------------------------------------
// The contract the UI codes against.

test("SCENES is a non-empty ordered list, default first", () => {
  assert.ok(Array.isArray(SCENES));
  assert.ok(SCENES.length >= 2, "a toggle needs something to toggle between");
  // First IS default: `sceneFor` falls back to SCENES[0] and /watch/'s picker
  // selects SCENES[0].id when localStorage holds nothing, so this one line is
  // the whole default and there is no second declaration to disagree with it.
  assert.equal(SCENES[0].id, "studio-grey");
  // The shipped look stays reachable — it was made non-default, not removed.
  assert.ok(SCENES.some((s) => s.id === "studio-dark"), "studio-dark must stay selectable");
});

test("every scene carries a unique id and an EN+SV name", () => {
  const seen = new Set();
  for (const s of SCENES) {
    assert.equal(typeof s.id, "string");
    assert.ok(s.id.length > 0, "a scene needs an id");
    assert.ok(!seen.has(s.id), `duplicate scene id ${s.id}`);
    seen.add(s.id);
    // Invariant 6: no English-only surface, ever, not even a menu label.
    assert.equal(typeof s.name.en, "string");
    assert.equal(typeof s.name.sv, "string");
    assert.ok(s.name.en.trim().length > 0, `${s.id} has no English name`);
    assert.ok(s.name.sv.trim().length > 0, `${s.id} has no Swedish name`);
    // A "translation" identical to the English one is how a half-done
    // translation passes a presence check; the catalogue's own bilingual
    // tests use the same guard.
    assert.notEqual(s.name.sv, s.name.en, `${s.id}: sv is a copy of en`);
  }
});

test("every scene is complete: background, environment, rig, exposure", () => {
  for (const s of [...SCENES, LUME_SCENE]) {
    for (const k of ["bg", "sky", "ground", "key", "fill", "rim"]) {
      assert.ok(Array.isArray(s[k]) && s[k].length === 3, `${s.id}.${k}`);
      for (const c of s[k]) assert.ok(Number.isFinite(c) && c >= 0, `${s.id}.${k}`);
    }
    for (const k of ["exposure", "softbox", "bounce"]) {
      assert.ok(Number.isFinite(s[k]) && s[k] > 0, `${s.id}.${k}`);
    }
    // A clear colour is written straight into the framebuffer, so it is a
    // display value and clipping it would be a silently different colour.
    for (const c of s.bg) assert.ok(c <= 1, `${s.id}.bg is out of display range`);
  }
});

test("sceneFor fails soft to the default", () => {
  assert.equal(sceneFor("studio-light").id, "studio-light");
  for (const bad of [undefined, null, "", "nope", "STUDIO-DARK", 7, {}, []]) {
    assert.equal(sceneFor(/** @type {any} */ (bad)).id, SCENES[0].id, `${String(bad)}`);
  }
});

test("the default is one of the two scenes that measure the same watch", () => {
  // Making studio-grey the default is allowed to change what a visitor sees
  // BEHIND the watch and nothing else. Grey and dark share every lighting
  // value (the test below pins that), so the switch cannot have moved a single
  // watch pixel — which is what made it a safe default to change.
  const d = sceneFor("studio-dark");
  assert.equal(SCENES[0].exposure, d.exposure);
  assert.deepEqual(SCENES[0].key, d.key);
  assert.notDeepEqual(SCENES[0].bg, d.bg, "the default must differ from dark somewhere");
});

// ---------------------------------------------------------------------------
// studio-dark must stay a no-op.

test("studio-dark is still the pre-#59 look, value for value", () => {
  // Every number the renderer used to carry inline, before scenes existed.
  // If one of these has to change, it is a deliberate change to the shipped
  // look and belongs in its own commit with its own before/after renders.
  // It is no longer the DEFAULT, but it is still the fixed point everything
  // else is measured against.
  const s = sceneFor("studio-dark");
  assert.deepEqual(s.bg, [0.045, 0.05, 0.065]);
  assert.deepEqual(s.sky, [0.60, 0.67, 0.82]);
  assert.deepEqual(s.ground, [0.055, 0.052, 0.058]);
  assert.deepEqual(s.key, [2.55, 2.5, 2.38]);
  assert.deepEqual(s.fill, [0.42, 0.47, 0.58]);
  assert.deepEqual(s.rim, [0.62, 0.66, 0.78]);
  assert.equal(s.exposure, 1.12);
  assert.equal(s.softbox, 0.30);
  assert.equal(s.bounce, 0.9);
});

test("lights out is the pre-#59 lume rig, and is dark", () => {
  assert.deepEqual(LUME_SCENE.bg, [0.01, 0.012, 0.02]);
  assert.deepEqual(LUME_SCENE.sky, [0.02, 0.026, 0.045]);
  assert.deepEqual(LUME_SCENE.ground, [0.004, 0.005, 0.009]);
  assert.deepEqual(LUME_SCENE.key, [0.05, 0.055, 0.07]);
  assert.deepEqual(LUME_SCENE.fill, [0.02, 0.024, 0.04]);
  assert.deepEqual(LUME_SCENE.rim, [0.02, 0.026, 0.05]);
  assert.equal(LUME_SCENE.exposure, 1.7);
  // The point of the mode: nothing in the room competes with the glow.
  const brightest = Math.max(...LUME_SCENE.bg, ...LUME_SCENE.sky, ...LUME_SCENE.key);
  assert.ok(brightest < 0.1, `lights out is not dark: ${brightest}`);
});

test("lights out is one record, so it cannot be lit by a bright scene", () => {
  // The renderer picks LUME_SCENE *instead of* the selected scene rather than
  // blending the two — which is what makes "stays dark in every scene" a
  // property of the code rather than of three sets of numbers agreeing.
  assert.match(RENDER_SRC, /const sc = lumeMode \? LUME_SCENE : scene;/);
  // And nothing downstream may re-introduce a per-scene lume literal.
  const body = RENDER_SRC.slice(RENDER_SRC.indexOf("const sc = lumeMode"));
  assert.doesNotMatch(body.slice(0, 2000), /lumeMode \? \[/);
});

// ---------------------------------------------------------------------------
// The mechanism: background and environment cannot disagree.

test("a derived scene's background IS its own backdrop, tonemapped", () => {
  const derived = SCENES.filter((s) => s.matched);
  assert.ok(derived.length >= 1, "at least one scene must be background-matched");
  for (const s of derived) {
    assert.deepEqual(s.bg, toneMap(sceneBackdrop(s), s.exposure), s.id);
  }
});

test("studio-dark's background does NOT match — the reported defect", () => {
  // This is feedback #59's observation, measured. The shipped studio clears to
  // ~0.05 while the room its own reflections show tonemaps to ~0.63: two and a
  // half stops apart, on the pixel where the two meet. Kept as an assertion so
  // that if someone ever quietly relights that scene, this test says so
  // instead of the change passing as a tidy-up.
  const s = sceneFor("studio-dark");
  assert.equal(s.matched, false);
  const want = toneMap(sceneBackdrop(s), s.exposure);
  const gap = Math.max(...want.map((c, i) => Math.abs(c - s.bg[i])));
  assert.ok(gap > 0.4, `expected a large mismatch, got ${gap.toFixed(3)}`);
});

test("the grey backdrop is a controlled experiment, not a new look", () => {
  // studio-grey exists to answer the hypothesis: it changes the background and
  // NOTHING else, so any difference between it and studio-dark is caused by
  // the background alone. If a later edit relights it, it stops being evidence.
  const dark = sceneFor("studio-dark");
  const grey = sceneFor("studio-grey");
  for (const k of ["sky", "ground", "key", "fill", "rim"]) {
    assert.deepEqual(grey[k], dark[k], `studio-grey.${k} must equal studio-dark's`);
  }
  for (const k of ["exposure", "softbox", "bounce"]) {
    assert.equal(grey[k], dark[k], `studio-grey.${k} must equal studio-dark's`);
  }
  assert.notDeepEqual(grey.bg, dark.bg);
});

test("a light scene brings the rig down as the room comes up", () => {
  // Otherwise a light background is just an overexposed dark one: the whole
  // point is that a bright room lights the subject by itself.
  const dark = sceneFor("studio-dark");
  const light = sceneFor("studio-light");
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  assert.ok(lum(light.sky) > lum(dark.sky), "the light room is not brighter");
  assert.ok(lum(light.ground) > lum(dark.ground), "the light floor is not brighter");
  assert.ok(lum(light.key) < lum(dark.key), "the key did not come down");
  assert.ok(light.exposure < dark.exposure, "the exposure did not come down");
});

// ---------------------------------------------------------------------------
// The tonemap mirror, and the rig PR #361 established.

test("toneMap matches the shader's curve at its fixed points", () => {
  assert.deepEqual(toneMap([0, 0, 0], 1.12), [0, 0, 0]);
  // Monotonic and saturating: the two properties the render depends on.
  const ramp = [0, 0.1, 0.25, 0.5, 1, 2, 8].map((v) => toneMap([v, v, v], 1)[0]);
  for (let i = 1; i < ramp.length; i++) assert.ok(ramp[i] > ramp[i - 1]);
  assert.ok(ramp[ramp.length - 1] <= 1);
  // Exposure has to act BEFORE the curve, or it would be a plain multiply.
  const a = toneMap([0.3, 0.3, 0.3], 2)[0];
  const b = toneMap([0.3, 0.3, 0.3], 1)[0] * 2;
  assert.ok(a < b, "exposure is being applied after the tonemap");
});

test("the scene swap did not undo PR #361's lighting rig", () => {
  // The rig dips under the horizon with the camera, `dip` is exactly 1 above
  // it, and below it the key is deliberately shallower than its mirror image
  // (0.5 against the 0.95 it uses above). A scene owns the light COLOURS; it
  // must not have quietly taken over the light DIRECTIONS.
  assert.match(RENDER_SRC, /const dip = pitch >= 0 \? 1 : Math\.tanh\(pitch \* 2\.2\);/);
  assert.match(RENDER_SRC, /uKeyDir, dirAt\(yaw \+ 0\.62, \(dip >= 0 \? 0\.95 : 0\.5\) \* dip\)/);
  assert.match(RENDER_SRC, /uFillDir, dirAt\(yaw - 1\.25, \(dip >= 0 \? 0\.2 : 0\.45\) \* dip\)/);
  assert.match(RENDER_SRC, /uRimDir, dirAt\(yaw \+ Math\.PI \+ 0\.35, \(dip >= 0 \? 0\.55 : 0\.3\) \* dip\)/);
  // And the ground still lifts toward the sky as the camera goes under — by a
  // FRACTION of what it did. See watch-shading.test.js for why the number
  // came down and why nothing above the horizon can notice.
  assert.match(RENDER_SRC, /uGround, sc\.ground\.map\(\(c, i\) => c \+ \(sc\.sky\[i\] - c\) \* 0\.06 \* under\)/);
});

test("the renderer exposes setScene and takes every value from the scene", () => {
  assert.match(RENDER_SRC, /\n {4}setScene\(id\) \{/);
  assert.match(RENDER_SRC, /scene = sceneFor\(id\);/);
  // The four things feedback #59 requires come from one record.
  assert.match(RENDER_SRC, /gl\.clearColor\(bg\[0\], bg\[1\], bg\[2\], 1\)/);
  assert.match(RENDER_SRC, /uSky, sc\.sky/);
  assert.match(RENDER_SRC, /uScene, sc\.exposure, lumeMode, sc\.softbox, sc\.bounce/);
  // No stray literal background left behind to drift again.
  assert.doesNotMatch(RENDER_SRC, /0\.045, 0\.05, 0\.065/);
});
