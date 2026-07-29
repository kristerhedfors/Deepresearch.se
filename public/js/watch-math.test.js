// Unit suite for the watch builder's render maths.
//
// These seven functions were untested for as long as they lived inside
// watch-render.js, because that module needs a WebGL context to load. The
// interesting property of matrix code is that a wrong answer still renders —
// it just renders something subtly wrong — so the assertions here are about
// KNOWN POINTS rather than about the array contents: transform a vector whose
// image can be worked out by hand and check where it lands.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mat4, mul, perspective, lookAt, modelMatrix, normalMatrix, linear } from "./watch-math.js";

/** Apply a column-major 4×4 to a vec3 (w = 1), returning [x, y, z, w]. */
function apply(m, [x, y, z]) {
  return [0, 1, 2, 3].map((r) => m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r]);
}

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !== ${b}`);
const nearAll = (a, b, eps = 1e-6) => a.forEach((v, i) => near(v, b[i], eps));

describe("mat4", () => {
  test("is the identity, and a fresh Float32Array each call", () => {
    const m = mat4();
    assert.ok(m instanceof Float32Array);
    assert.equal(m.length, 16);
    nearAll([...m], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    nearAll(apply(m, [3, -4, 5]), [3, -4, 5, 1], 1e-5);
    m[0] = 9;
    assert.equal(mat4()[0], 1, "the next call is not the same buffer");
  });
});

describe("mul", () => {
  test("composes transforms in the column-major order (a applied after b)", () => {
    const rot = modelMatrix(mat4(), Math.PI / 2, 0, 0, 0, 0);
    const move = modelMatrix(mat4(), 0, 10, 0, 0, 0);
    const out = mul(mat4(), rot, move);
    // move first (x += 10), then the quarter turn about Y: +x goes to -z.
    nearAll(apply(out, [0, 0, 0]).slice(0, 3), apply(rot, apply(move, [0, 0, 0]).slice(0, 3)).slice(0, 3), 1e-5);
    nearAll(apply(out, [0, 0, 0]).slice(0, 3), [0, 0, -10], 1e-5);
  });

  test("multiplying by the identity is a no-op on either side", () => {
    const a = modelMatrix(mat4(), 0.7, 1, 2, 3, 0.2);
    nearAll([...mul(mat4(), a, mat4())], [...a], 1e-6);
    nearAll([...mul(mat4(), mat4(), a)], [...a], 1e-6);
  });

  test("aliasing out with an input is safe (the copy-on-alias guard)", () => {
    const a = modelMatrix(mat4(), 0.4, 5, 0, 0, 0);
    const b = modelMatrix(mat4(), 0.9, 0, 3, 0, 0);
    const expected = [...mul(mat4(), a, b)];
    const aliased = modelMatrix(mat4(), 0.4, 5, 0, 0, 0);
    mul(aliased, aliased, b);
    nearAll([...aliased], expected, 1e-6);
  });
});

describe("perspective", () => {
  test("puts the near plane at NDC -1 and the far plane at +1", () => {
    const p = perspective(mat4(), (60 * Math.PI) / 180, 1, 5, 900);
    const atNear = apply(p, [0, 0, -5]);
    const atFar = apply(p, [0, 0, -900]);
    near(atNear[2] / atNear[3], -1, 1e-4);
    near(atFar[2] / atFar[3], 1, 1e-4);
    near(atNear[3], 5, 1e-4); // w carries the view-space depth for the perspective divide
  });

  test("aspect widens x only, and the fov sets the vertical extent", () => {
    const square = perspective(mat4(), Math.PI / 2, 1, 1, 100);
    const wide = perspective(mat4(), Math.PI / 2, 2, 1, 100);
    near(square[0], 1, 1e-6);
    near(wide[0], 0.5, 1e-6); // twice as wide fits twice as much x in the same clip range
    near(square[5], wide[5], 1e-6); // y is untouched by aspect
    // At a 90° vertical fov the near plane's half-height equals its distance.
    const edge = apply(square, [0, 1, -1]);
    near(edge[1] / edge[3], 1, 1e-6);
  });

  test("zeroes the rest of the matrix so a reused buffer cannot leak", () => {
    const dirty = mat4();
    dirty.fill(7);
    const p = perspective(dirty, Math.PI / 3, 1.5, 1, 10);
    for (const i of [1, 2, 3, 4, 6, 7, 8, 9, 12, 13, 15]) assert.equal(p[i], 0, `slot ${i} cleared`);
  });
});

describe("lookAt", () => {
  test("maps the camera's own position to the view-space origin", () => {
    const v = lookAt(mat4(), [30, 20, 60], [0, 4, 0], [0, 1, 0]);
    nearAll(apply(v, [30, 20, 60]).slice(0, 3), [0, 0, 0], 1e-4);
  });

  test("puts the target down the negative z axis, at the eye's distance", () => {
    const eye = [0, 0, 40];
    const center = [0, 0, 0];
    const v = lookAt(mat4(), eye, center, [0, 1, 0]);
    nearAll(apply(v, center).slice(0, 3), [0, 0, -40], 1e-4);
    // World +x stays view +x and world +y stays view +y for this camera.
    nearAll(apply(v, [1, 0, 0]).slice(0, 3), [1, 0, -40], 1e-4);
    nearAll(apply(v, [0, 1, 0]).slice(0, 3), [0, 1, -40], 1e-4);
  });

  test("an orbited camera keeps the target centred and the distance intact", () => {
    const dist = 50;
    for (const a of [0, 0.6, Math.PI / 2, 2.5, Math.PI]) {
      const eye = [dist * Math.sin(a), 12, dist * Math.cos(a)];
      const v = lookAt(mat4(), eye, [0, 0, 0], [0, 1, 0]);
      const seen = apply(v, [0, 0, 0]).slice(0, 3);
      near(seen[0], 0, 1e-4);
      near(seen[1], 0, 1e-4);
      near(seen[2], -Math.hypot(...eye), 1e-4);
    }
  });

  test("a degenerate eye/center pair falls back instead of producing NaN", () => {
    const v = lookAt(mat4(), [0, 0, 0], [0, 0, 0], [0, 1, 0]);
    // The || 1 guards on both normalizations are what keep this finite; a NaN
    // matrix silently blanks the whole scene.
    for (const n of v) assert.ok(Number.isFinite(n), "no NaN escapes");
  });
});

describe("modelMatrix", () => {
  test("rotates about Y, then translates", () => {
    const m = modelMatrix(mat4(), Math.PI / 2, 1, 2, 3, 0);
    // A quarter turn about +Y sends world +x to -z; the translation follows.
    nearAll(apply(m, [1, 0, 0]).slice(0, 3), [1, 2, 2], 1e-6);
    nearAll(apply(m, [0, 0, 0]).slice(0, 3), [1, 2, 3], 1e-6);
    nearAll(apply(m, [0, 5, 0]).slice(0, 3), [1, 7, 3], 1e-6); // the axis of rotation is untouched
  });

  test("the optional rz rolls about z before the y turn", () => {
    const m = modelMatrix(mat4(), 0, 0, 0, 0, Math.PI / 2);
    nearAll(apply(m, [1, 0, 0]).slice(0, 3), [0, 1, 0], 1e-6);
    const noRoll = modelMatrix(mat4(), 0.3, 1, 1, 1, 0);
    const undefinedRoll = modelMatrix(mat4(), 0.3, 1, 1, 1, undefined);
    nearAll([...undefinedRoll], [...noRoll], 1e-6); // a missing rz is a zero roll
  });

  test("stays a rigid transform — lengths and angles survive", () => {
    const m = modelMatrix(mat4(), 1.1, 4, -2, 7, 0.35);
    const o = apply(m, [0, 0, 0]).slice(0, 3);
    for (const p of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [2, -3, 5]]) {
      const moved = apply(m, p).slice(0, 3);
      near(Math.hypot(...moved.map((v, i) => v - o[i])), Math.hypot(...p), 1e-5);
    }
  });
});

describe("normalMatrix", () => {
  test("is the 3×3 rotation block, translation dropped", () => {
    const m = modelMatrix(mat4(), 0.8, 100, -50, 25, 0.2);
    const n = normalMatrix(new Float32Array(9), m);
    nearAll([...n], [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]], 1e-6);
  });

  test("keeps normals unit length for any rotation the builder produces", () => {
    for (const [ry, rz] of [[0, 0], [1.2, 0], [0, 0.9], [2.7, -0.4]]) {
      const n = normalMatrix(new Float32Array(9), modelMatrix(mat4(), ry, 9, 9, 9, rz));
      for (const [x, y, z] of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
        const t = [0, 1, 2].map((r) => n[r] * x + n[3 + r] * y + n[6 + r] * z);
        near(Math.hypot(...t), 1, 1e-5);
      }
    }
  });
});

describe("linear", () => {
  test("converts sRGB hex to linear with the 2.2 gamma", () => {
    nearAll(linear("#000000"), [0, 0, 0], 1e-9);
    nearAll(linear("#ffffff"), [1, 1, 1], 1e-9);
    nearAll(linear("#808080"), Array(3).fill(Math.pow(128 / 255, 2.2)), 1e-9);
  });

  test("accepts three-digit hex and a missing leading hash", () => {
    nearAll(linear("#f00"), linear("#ff0000"), 1e-9);
    nearAll(linear("abc"), linear("#aabbcc"), 1e-9);
  });

  test("falls back to the neutral grey rather than emitting NaN", () => {
    // A part with no colour must not blank the shader's uniform.
    for (const bad of [undefined, null, "", 0]) nearAll(linear(bad), linear("#888"), 1e-9);
  });

  test("darkens every channel — linear is below sRGB except at the ends", () => {
    const [r, g, b] = linear("#a8b0b9"); // the default steel case colour
    assert.ok(r < 0xa8 / 255 && g < 0xb0 / 255 && b < 0xb9 / 255);
    assert.ok(r < g && g < b, "the channel ordering survives the conversion");
  });
});
