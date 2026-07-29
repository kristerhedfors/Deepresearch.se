// @ts-check
// The watch builder's RENDER MATHS: column-major 4×4 matrices, the camera, and
// the sRGB→linear colour conversion the lighting model needs.
//
// Split out of public/js/watch-render.js so it can be Node-tested. Everything
// here is pure — arguments in, numbers out, no WebGL context, no canvas, no
// module state — while the module it came from cannot be loaded outside a
// browser at all (it imports its core by served path and needs a GL context to
// do anything). That asymmetry is the whole reason for the split: a sign error
// in lookAt or a transposed column in modelMatrix is invisible in review and
// shows up only as a render that looks subtly wrong, which is the worst kind of
// bug to have no test for.
//
// It is NOT in public/js/watch-core.js, which the Worker imports through the
// src/watch.js façade to serve /api/watch/catalog: camera matrices are of no
// use to a JSON endpoint, and the catalogue has no business carrying them.
//
// `mul` is currently called by nothing — the renderer hands the projection and
// view matrices to the shader separately and lets the GPU compose them. It
// moved across with the rest of the band rather than being deleted in a
// refactor pass; it is now at least covered, so a future caller gets a
// verified one.

// ---------------------------------------------------------------------------
// Minimal column-major 4×4 matrix maths. Hand-rolled because pulling in a
// matrix library for eight functions would be the first runtime dependency
// this repo has ever added to the client.

/** @returns {Float32Array} */
export function mat4() {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/**
 * @param {Float32Array} out
 * @param {Float32Array} a
 * @param {Float32Array} b
 */
export function mul(out, a, b) {
  const o = out === a || out === b ? new Float32Array(16) : out;
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[r] * b[c * 4] +
        a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] +
        a[12 + r] * b[c * 4 + 3];
    }
  }
  if (o !== out) out.set(o);
  return out;
}

/**
 * @param {Float32Array} out
 * @param {number} fovy radians
 * @param {number} aspect
 * @param {number} near
 * @param {number} far
 */
export function perspective(out, fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

/**
 * @param {Float32Array} out
 * @param {number[]} eye
 * @param {number[]} center
 * @param {number[]} up
 */
export function lookAt(out, eye, center, up) {
  let zx = eye[0] - center[0];
  let zy = eye[1] - center[1];
  let zz = eye[2] - center[2];
  let len = Math.hypot(zx, zy, zz) || 1;
  zx /= len;
  zy /= len;
  zz /= len;
  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  len = Math.hypot(xx, xy, xz) || 1;
  xx /= len;
  xy /= len;
  xz /= len;
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  out[0] = xx;
  out[1] = yx;
  out[2] = zx;
  out[3] = 0;
  out[4] = xy;
  out[5] = yy;
  out[6] = zy;
  out[7] = 0;
  out[8] = xz;
  out[9] = yz;
  out[10] = zz;
  out[11] = 0;
  out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  out[15] = 1;
  return out;
}

/**
 * Rotation about Y, then a translation. The only model transform we need.
 * @param {Float32Array} out
 * @param {number} ry radians about Y
 * @param {number} tx
 * @param {number} ty
 * @param {number} tz
 * @param {number} [rz] radians of roll about Z, applied first
 */
export function modelMatrix(out, ry, tx, ty, tz, rz) {
  const c = Math.cos(ry);
  const s = Math.sin(ry);
  const cz = Math.cos(rz || 0);
  const sz = Math.sin(rz || 0);
  // Rz then Ry, column-major.
  out[0] = c * cz;
  out[1] = sz;
  out[2] = -s * cz;
  out[3] = 0;
  out[4] = -c * sz;
  out[5] = cz;
  out[6] = s * sz;
  out[7] = 0;
  out[8] = s;
  out[9] = 0;
  out[10] = c;
  out[11] = 0;
  out[12] = tx;
  out[13] = ty;
  out[14] = tz;
  out[15] = 1;
  return out;
}

/**
 * The normal matrix for a rigid transform is just its rotation part.
 * @param {Float32Array} out a 9-element buffer (mat3)
 * @param {Float32Array} m
 */
export function normalMatrix(out, m) {
  out[0] = m[0];
  out[1] = m[1];
  out[2] = m[2];
  out[3] = m[4];
  out[4] = m[5];
  out[5] = m[6];
  out[6] = m[8];
  out[7] = m[9];
  out[8] = m[10];
  return out;
}

/**
 * sRGB hex → linear RGB, so the lighting maths happens in linear space.
 * @param {unknown} hex `#rgb`, `#rrggbb`, or anything falsy (a neutral grey)
 * @returns {number[]} three channels in 0..1
 */
export function linear(hex) {
  const h = String(hex || "#888").replace("#", "");
  const n = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const v = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  return v.map((c) => Math.pow(c, 2.2));
}
