// The watch builder's RENDERER: the browser half of the /watch/ surface.
// Everything deterministic — the catalogue, the compatibility rules, the
// geometry — lives in the pure core /js/watch-core.js and is Node-tested; the
// material response lives in /js/watch-materials.js and is Node-tested too.
// This module owns the parts a test runner cannot hold: a WebGL context, the
// painted canvas textures, a pointer-driven orbit camera, and the animation
// loop that sweeps the seconds hand at the NH35's real 6 beats per second.
//
// WHY WEBGL AND NOT A PIPELINE OF IMAGE TOOLS. The research behind this
// surface (docs/WATCH-BUILDER.md §2) came down to one constraint: the render
// has to be ROTATABLE and ZOOMABLE, which means it is not a picture at all but
// a scene the viewer drives. Nothing that renders server-side gives you that
// without shipping a frame per interaction, and the execution sandbox this
// project runs has no renderer in it anyway — no Blender, no ImageMagick, no
// numpy, and no network to install one from. So the geometry is generated in
// plain JavaScript from the catalogue's millimetres and drawn by the GPU
// already in the reader's device. No build step, no vendored engine, no added
// dependency (invariant 5).
//
// THE SHADING, AND WHY IT WAS REWRITTEN (feedback #56, 2026-07-30). The first
// version was a hand-rolled two-light model: a two-tone sky/ground environment
// approximated from the reflected ray's Y, one un-normalised Blinn-Phong lobe,
// a flat `pow(1 - NdotV, 4)` Fresnel, and an angular hash standing in for
// brushing. A user summarised the result as "case (and strap) metals look very
// off-putting with ugly reflections", "leather shouldn't be shiny like a mirror
// surface" and "lighting in general looks odd, especially for bezel inserts".
// All three are the same defect: one response, shared by every part. What
// replaced it:
//
//   * A real microfacet specular — GGX with a height-correlated Smith
//     visibility term and Schlick Fresnel driven by the material's OWN F0
//     (watch-materials.js), so gold is gold-coloured in its highlight and
//     leather reflects a neutral 3.5 %.
//   * A small procedural STUDIO instead of two flat colours: a soft
//     rectangular overhead softbox, a horizon gradient, a floor bounce and a
//     bright horizon line. Nearly everything a polished case shows you is the
//     environment, so a two-tone environment is why it looked plastic.
//   * ANISOTROPY along the direction the part is really finished in —
//     circumferential on a lathed case flank, along the band on a bracelet,
//     radial on a sunburst dial, axial teeth on a crown's coin edge — built
//     from an object-space frame, because the core emits no tangents.
//   * A dielectric path with sheen, so leather, suede, nylon and rubber stop
//     borrowing the metal's environment reflection.
//   * Normal-mapped RELIEF from a painted height field, so applied indices,
//     cut apertures and stamped dial patterns have depth without any change to
//     the geometry modules (which stay the single source of shape).
//   * ACES-ish tonemapping instead of Reinhard, which is most of why the old
//     highlights went chalky-white and flat.
//
// Everything above runs in one pass with no extensions: WebGL1, GLSL ES 1.00,
// `texture2D`/`varying`, 16-bit indices, no derivatives. The page's no-WebGL
// message path is untouched.
//
// THE PAINTERS HOLD NO GEOMETRY. `paintDial` takes every radius, angle and
// aperture from the `dialLayout()` result `buildMeshes` already built the
// hands and the rehaut against. It used to carry its own fractions in
// parallel with the core's, and the two drifted — which is what feedback
// #56's "day clips into date" was, along with a GMT numeral printed under the
// date window and a marker under it. The core collision-checks that layout
// over every case × every dial; this file renders the answer. A number this
// file needs and `dialLayout` does not emit is a gap in the core, not a
// licence to guess one back.

import {
  buildMeshes,
  resolveBuild,
  bezelLayout,
  LUMES,
  PLATFORMS,
} from "/js/watch-core.js";
// The camera/matrix maths and the sRGB→linear conversion live in their own
// leaf so they can be Node-tested; nothing below this line can be.
import {
  linear,
  lookAt,
  mat4,
  modelMatrix,
  normalMatrix,
  perspective,
} from "/js/watch-math.js";
import {
  crystalMaterial,
  dialMaterialId,
  dialRelief,
  finishMaterialId,
  insertMaterialId,
  markerIsApplied,
  materialFor,
  meshMaterialId,
  strapMaterialId,
} from "/js/watch-materials.js";

// ---------------------------------------------------------------------------
// Shaders.

const VERT = `
attribute vec3 aPos;
attribute vec3 aNormal;
attribute vec2 aUv;
uniform mat4 uProj, uView, uModel;
uniform mat3 uNormalMat;
varying vec3 vWorld, vNormal, vLocal, vLocalN;
varying vec2 vUv;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vWorld = w.xyz;
  vNormal = uNormalMat * aNormal;
  vLocal = aPos;
  // The OBJECT-space normal. The brush direction of a real finish is a
  // property of the part, not of where the part currently sits, so the
  // tangent frame is built here and rotated into the world afterwards —
  // which is also the only way to get one at all, since the geometry core
  // emits positions, normals and UVs and no tangents.
  vLocalN = aNormal;
  vUv = aUv;
  gl_Position = uProj * uView * w;
}`;

const FRAG = `
precision highp float;
varying vec3 vWorld, vNormal, vLocal, vLocalN;
varying vec2 vUv;

uniform mat3 uNormalMat;
uniform vec3 uCam, uSky, uGround;
uniform vec3 uKeyDir, uKeyCol, uFillDir, uFillCol, uRimDir, uRimCol;
uniform vec4 uScene;   // x exposure, y lights-out, z softbox half-width, w floor bounce
uniform vec3 uColor, uF0, uSheenCol, uGlow, uAxis;
uniform vec4 uMat0;    // x roughness, y metalness, z anisotropy, w brush mode
uniform vec4 uMat1;    // x grain amplitude, y grain frequency, z env amount, w mesh radius
uniform vec4 uMat2;    // x coat, y coat roughness, z relief, w roughness under the applied mask
uniform vec4 uMat3;    // x alpha, y use albedo texture, z constant lume, w glass
uniform float uLogo;   // 0 none, ±1 stamp the crown mark on that cap
uniform sampler2D uTex, uLumeTex, uDetailTex;

const float PI = 3.14159265;

// Three octaves of sine — smooth, cheap, and free of the aliasing a hash
// gives you on a surface the viewer can zoom into.
float wave(float x) {
  return sin(x) * 0.6 + sin(x * 2.31 + 1.7) * 0.28 + sin(x * 4.77 + 3.1) * 0.12;
}

// A studio, not a sky. Everything a metal shows you comes from here, so it
// has to have STRUCTURE: a bright soft rectangle overhead (the softbox), the
// line where the table meets the backdrop, and a dim bounce off the table.
// Roughness blurs all three, which is what makes a bead-blasted case and a
// polished one look like different metals rather than the same metal at two
// brightnesses.
vec3 studio(vec3 R, float rough) {
  float y = clamp(R.y, -1.0, 1.0);
  vec3 c = mix(uGround, uSky, smoothstep(-0.30, 0.55, y));
  c += uGround * uScene.w * smoothstep(0.05, -0.85, y);
  c += uSky * 0.22 * exp(-abs(y) * mix(16.0, 2.5, rough));
  vec3 kd = normalize(uKeyDir);
  vec3 ku = normalize(cross(kd, vec3(0.0, 0.0, 1.0)) + vec3(1e-4));
  vec3 kv = cross(kd, ku);
  float d = max(abs(dot(R, ku)) * 0.62, abs(dot(R, kv)));
  float hw = mix(uScene.z, 0.85, rough);
  float soft = mix(0.03, 0.70, rough);
  c += uKeyCol * (1.0 - smoothstep(hw, hw + soft, d)) * step(0.0, dot(R, kd));
  return c;
}

/** The diffuse half of the same room: no softbox, just the dome. */
vec3 ambient(vec3 N) {
  return mix(uGround, uSky, smoothstep(-0.75, 0.95, N.y));
}

float dGGX(float NoH, float ToH, float BoH, float at, float ab) {
  float d = ToH * ToH / (at * at) + BoH * BoH / (ab * ab) + NoH * NoH;
  return 1.0 / (PI * at * ab * d * d);
}

float vSmith(float NoV, float NoL, float a) {
  float a2 = a * a;
  float gv = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
  float gl = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-5);
}

vec3 fSchlick(vec3 f0, float u) {
  float m = 1.0 - u;
  float m2 = m * m;
  return f0 + (1.0 - f0) * (m2 * m2 * m);
}

// Karis' analytic fit to the split-sum environment BRDF: (scale, bias) for
// the material's F0. Cheaper than a lookup texture and one less thing to
// upload.
vec2 envBRDF(float rough, float NoV) {
  const vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
  const vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
  vec4 r = rough * c0 + c1;
  float a004 = min(r.x * r.x, exp2(-9.28 * NoV)) * r.x + r.y;
  return vec2(-1.04, 1.04) * a004 + r.zw;
}

vec3 lobe(vec3 N, vec3 V, vec3 T, vec3 B, vec3 L, vec3 col, vec3 f0,
          float at, float ab, float NoV) {
  float NoL = dot(N, L);
  if (NoL <= 0.0) return vec3(0.0);
  vec3 H = normalize(L + V);
  float NoH = max(dot(N, H), 0.0);
  float VoH = max(dot(V, H), 0.0);
  return col * NoL * dGGX(NoH, dot(T, H), dot(B, H), at, ab)
       * vSmith(NoV, NoL, sqrt(at * ab)) * fSchlick(f0, VoH);
}

// The mark struck into a signed crown: a raised ring with six teeth around a
// centre pip. Height only — the normal comes from differencing it.
float crownMark(float r, float a) {
  float ring = smoothstep(0.30, 0.34, r) - smoothstep(0.52, 0.56, r);
  return ring * (0.55 + 0.45 * sin(a * 6.0)) * 0.7 + (1.0 - smoothstep(0.09, 0.14, r));
}

void main() {
  vec3 N = normalize(vNormal);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(uCam - vWorld);
  vec4 tex = uMat3.y > 0.5 ? texture2D(uTex, vUv) : vec4(1.0);
  vec3 albedo = uColor * tex.rgb;

  float rough = uMat0.x;
  float metal = uMat0.y;
  vec3 f0 = uF0;

  // --- the object-space brush frame ---------------------------------------
  vec3 Nl = normalize(vLocalN);
  vec3 axis = normalize(uAxis);
  vec3 fallback = normalize(cross(Nl, abs(Nl.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  float mode = uMat0.w;
  vec3 Tl = fallback;
  if (mode > 0.5) {
    if (mode < 1.5) Tl = cross(axis, vLocal);                      // circumferential
    else if (mode < 2.5) Tl = axis;                                // along the axis
    else if (mode < 3.5) Tl = vLocal - axis * dot(vLocal, axis);   // radial
    else if (mode < 4.5) Tl = axis;                                // knurl teeth
    else Tl = cross(axis, vLocal);                                 // isotropic grain
    Tl = Tl - Nl * dot(Nl, Tl);
    float tl = length(Tl);
    // Degenerate exactly on the axis (the pole of a lathe): any stable frame
    // will do there, and an unstable one is a flickering pixel.
    Tl = tl > 1e-4 ? Tl / tl : fallback;
  }
  vec3 Bl = cross(Nl, Tl);

  // --- micro-grain: grooves across the brush direction --------------------
  if (uMat1.x > 0.0) {
    float gc;
    if (mode > 3.5 && mode < 4.5) {
      // A coin edge has a fixed COUNT of teeth around the crown, not a fixed
      // pitch, so its coordinate is the angle about the axis.
      vec3 e1 = normalize(abs(axis.y) < 0.9 ? cross(axis, vec3(0.0, 1.0, 0.0)) : cross(axis, vec3(1.0, 0.0, 0.0)));
      vec3 e2 = cross(axis, e1);
      gc = atan(dot(vLocal, e2), dot(vLocal, e1)) * uMat1.y;
    } else {
      gc = dot(vLocal, Bl) * uMat1.y * 6.2831853;
    }
    vec3 Bw = normalize(uNormalMat * Bl);
    N = normalize(N + Bw * wave(gc) * uMat1.x);
    if (mode > 4.5) {
      // Pebbled rather than streaked: a second groove set across the first.
      vec3 Tw = normalize(uNormalMat * Tl);
      N = normalize(N + Tw * wave(dot(vLocal, Tl) * uMat1.y * 5.11 + 2.3) * uMat1.x);
    }
  }

  // --- painted relief -----------------------------------------------------
  // The dial and insert painters write a height field into the detail map's
  // RED channel (0.5 = the plate's own surface) and mark applied METAL in the
  // BLUE one. Four taps and a central difference turn that into a normal, so
  // an applied index has a real edge and a date window a real depth without
  // one extra triangle.
  if (uMat2.z > 0.0) {
    float e = 1.7 / 512.0;
    float hl = texture2D(uDetailTex, vUv - vec2(e, 0.0)).r;
    float hr = texture2D(uDetailTex, vUv + vec2(e, 0.0)).r;
    float hd = texture2D(uDetailTex, vUv - vec2(0.0, e)).r;
    float hu = texture2D(uDetailTex, vUv + vec2(0.0, e)).r;
    float mask = texture2D(uDetailTex, vUv).b;
    // Every textured part here is a disc whose UVs run with object X and Z
    // (see annulus() and cone() in watch-core.js), so the texture frame is
    // known without per-vertex tangents.
    vec3 Tu = normalize(uNormalMat * vec3(1.0, 0.0, 0.0));
    vec3 Tv = normalize(uNormalMat * vec3(0.0, 0.0, 1.0));
    N = normalize(N - (Tu * (hr - hl) + Tv * (hu - hd)) * uMat2.z);
    rough = mix(rough, uMat2.w, mask);
    metal = mix(metal, 1.0, mask);
    f0 = mix(f0, clamp(albedo, vec3(0.35), vec3(0.95)), mask);
  }

  // --- the signed crown ---------------------------------------------------
  if (uLogo != 0.0 && dot(Nl, axis) * uLogo > 0.86) {
    vec3 e1 = normalize(abs(axis.y) < 0.9 ? cross(axis, vec3(0.0, 1.0, 0.0)) : cross(axis, vec3(1.0, 0.0, 0.0)));
    vec3 e2 = cross(axis, e1);
    vec3 radial = vLocal - axis * dot(vLocal, axis);
    float rr = length(radial) / max(uMat1.w, 0.001);
    float ang = atan(dot(vLocal, e2), dot(vLocal, e1));
    float h = crownMark(rr, ang);
    float dh = crownMark(rr + 0.02, ang) - h;
    N = normalize(N - normalize(uNormalMat * normalize(radial + vec3(1e-5))) * dh * 6.0);
    rough = mix(rough, 0.10, clamp(h, 0.0, 1.0) * 0.7);
  }

  // --- the BRDF -----------------------------------------------------------
  rough = clamp(rough, 0.03, 1.0);
  float a = rough * rough;
  float aniso = clamp(uMat0.z, 0.0, 0.94);
  float at = max(a * (1.0 + aniso), 0.0015);
  float ab = max(a * (1.0 - aniso), 0.0015);

  vec3 T = normalize(uNormalMat * Tl);
  T = normalize(T - N * dot(N, T));
  vec3 B = cross(N, T);
  float NoV = max(dot(N, V), 1e-4);

  vec3 kd = normalize(uKeyDir);
  vec3 fd = normalize(uFillDir);
  vec3 rd = normalize(uRimDir);

  // The lights have SIZE. Flooring the lobe width is the cheap stand-in for
  // that, and without it a polished case under a directional light shows a
  // one-pixel firefly instead of a softbox.
  float atK = max(at, 0.012), abK = max(ab, 0.012);
  float atF = max(at, 0.050), abF = max(ab, 0.050);

  vec3 spec = lobe(N, V, T, B, kd, uKeyCol, f0, atK, abK, NoV)
            + lobe(N, V, T, B, fd, uFillCol, f0, atF, abF, NoV)
            + lobe(N, V, T, B, rd, uRimCol, f0, atF, abF, NoV);

  float NoLk = max(dot(N, kd), 0.0);
  vec3 irr = uKeyCol * NoLk
           + uFillCol * max(dot(N, fd), 0.0)
           + uRimCol * max(dot(N, rd), 0.0) * 0.5
           + ambient(N) * 0.55;
  vec3 diffuse = albedo * (1.0 - metal) * irr / PI;

  vec3 R = reflect(-V, N);
  // Anisotropy smears the reflected environment along the grooves. Bending
  // the reflected ray toward the bitangent plane is the cheap version of
  // that, and it is what turns a brushed flank's reflection into a streak.
  if (aniso > 0.02) R = normalize(R - T * dot(R, T) * aniso * 0.9);
  vec2 eb = envBRDF(rough, NoV);
  vec3 envSpec = studio(R, rough) * (f0 * eb.x + vec3(eb.y)) * uMat1.z;

  // Sheen: the pale grazing-angle glow of a fibrous surface. This is what
  // leather, suede and nylon have INSTEAD of a mirror reflection.
  vec3 sheen = uSheenCol * pow(1.0 - NoV, 3.0) * (0.30 + 0.70 * NoLk) * 1.6;

  vec3 color = diffuse + spec + envSpec + sheen;

  // A clear coat over the body: lacquered dials, patent leather, fumé.
  if (uMat2.x > 0.0) {
    float ca = max(uMat2.y * uMat2.y, 0.002);
    vec3 cf0 = vec3(0.04);
    vec3 cs = lobe(N, V, T, B, kd, uKeyCol, cf0, ca, ca, NoV)
            + lobe(N, V, T, B, fd, uFillCol, cf0, max(ca, 0.04), max(ca, 0.04), NoV);
    vec2 cb = envBRDF(uMat2.y, NoV);
    cs += studio(R, uMat2.y) * (cf0 * cb.x + vec3(cb.y)) * 0.8;
    color = color * (1.0 - 0.06 * uMat2.x) + cs * uMat2.x;
  }

  float alpha = uMat3.x;

  // Sapphire: almost invisible face-on (that is what anti-reflective coating
  // buys you) and bright at glancing angles, where the dome catches the
  // softbox. uF0 already carries the coating's effect.
  if (uMat3.w > 0.5) {
    vec3 fr = fSchlick(f0, NoV);
    float peak = pow(max(dot(N, normalize(kd + V)), 0.0), 900.0);
    color = albedo * 0.03 + studio(reflect(-V, N), 0.02) * fr + uKeyCol * peak * 2.2;
    alpha = clamp(uMat3.x + fr.g * 1.5 + peak * 1.4, 0.0, 1.0);
  }

  // Lights out: everything falls away except what was charged.
  color = mix(color, color * 0.03, uScene.y);
  float lumeMask = max(texture2D(uLumeTex, vUv).r, uMat3.z);
  color += uGlow * lumeMask * (0.10 + 1.9 * uScene.y);

  // ACES-ish filmic curve rather than Reinhard: it keeps a highlight's colour
  // as it rolls off instead of washing everything toward white, which is most
  // of why the old render's metals looked chalky.
  color *= uScene.x;
  color = (color * (2.51 * color + 0.03)) / (color * (2.43 * color + 0.59) + 0.14);
  gl_FragColor = vec4(pow(clamp(color, 0.0, 1.0), vec3(1.0 / 2.2)), alpha);
}`;

/**
 * @param {WebGLRenderingContext} gl
 * @param {number} type
 * @param {string} src
 */
function shader(gl, type, src) {
  const s = gl.createShader(type);
  if (!s) throw new Error("shader alloc failed");
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(s) || "shader compile failed");
  }
  return s;
}

// ---------------------------------------------------------------------------
// Texture painting. The dial, the bezel insert and the chapter ring are all
// discs, and the core's UVs map each one onto an inscribed circle — so every
// painter below draws into a square canvas, centre at the middle, radius at
// half the size, 12 o'clock straight up.
//
// Each painter now produces up to three canvases:
//   albedo — the colour, as before.
//   lume   — the RED channel is the mask "lights out" multiplies the glow by.
//   relief — RED is a height field with 0.5 as the plate's own surface, BLUE
//            marks the parts that are polished metal rather than paint.
// The relief map is half the albedo's resolution because the shader only ever
// differences it, and a blurred height field is a feature: it anti-aliases
// the bevels for free as the watch shrinks.

const TEX = 1024;
const REL = 512;

/** @param {number} size */
function texCanvas(size) {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  return c;
}

/** The relief encoding: `h` 0.5 = flat, 1 = proud, 0 = cut; `mask` = metal. */
function relief(h, mask) {
  const r = Math.round(Math.max(0, Math.min(1, h)) * 255);
  const b = Math.round(Math.max(0, Math.min(1, mask || 0)) * 255);
  return `rgb(${r},0,${b})`;
}
const FLAT = relief(0.5, 0);

/**
 * A tiny deterministic generator, so a "textured" dial paints the same way
 * every time it is rebuilt. Math.random() here meant the snowflake pattern
 * jumped on every part change, which reads as a glitch rather than a finish.
 * @param {number} seed
 */
function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Canvas position for a polar coordinate with 12 o'clock up and hours running
 * clockwise — the same convention `dialLayout` emits angles in.
 * @param {number} size
 * @param {number} angle
 * @param {number} r 0..1 of the disc radius
 */
function polar(size, angle, r) {
  const c = size / 2;
  return [c + Math.sin(angle) * r * c, c - Math.cos(angle) * r * c];
}

/**
 * The stamped patterns: the dial finishes that are formed in the metal rather
 * than printed on it. A sunburst is deliberately NOT here — it has no height,
 * only direction, and it is handled as radial anisotropy in the material.
 * @param {CanvasRenderingContext2D} r the relief context
 * @param {number} size
 * @param {{pattern: string, patternDepth: number}} plan
 */
function paintPattern(r, size, plan) {
  if (plan.pattern === "none") return;
  const c = size / 2;
  const d = plan.patternDepth;
  r.save();
  r.beginPath();
  r.arc(c, c, c, 0, Math.PI * 2);
  r.clip();
  if (plan.pattern === "snowflake") {
    const rand = rng(0x5eed);
    for (let i = 0; i < 1400; i++) {
      const h = 0.5 + (rand() - 0.5) * 0.5 * d;
      r.fillStyle = relief(h, 0);
      r.beginPath();
      r.ellipse(rand() * size, rand() * size, 8 + rand() * 20, 3 + rand() * 5, Math.PI * 0.25, 0, Math.PI * 2);
      r.fill();
    }
  } else if (plan.pattern === "clous" || plan.pattern === "waffle") {
    // Clous de Paris is a field of little raised pyramids; a waffle dial is
    // the same grid cut the other way round.
    const step = size / 34;
    const raised = plan.pattern === "clous";
    r.save();
    r.translate(c, c);
    r.rotate(Math.PI / 4);
    for (let x = -size; x < size; x += step) {
      for (let y = -size; y < size; y += step) {
        r.fillStyle = relief(0.5 + (raised ? 0.42 : -0.42) * d, 0);
        r.fillRect(x + step * 0.12, y + step * 0.12, step * 0.76, step * 0.76);
      }
    }
    r.restore();
  } else if (plan.pattern === "guilloche") {
    // Engine turning: fine concentric cuts, alternating with the ridges left
    // between them.
    for (let i = 0; i < 120; i++) {
      r.strokeStyle = relief(0.5 + (i % 2 ? 0.38 : -0.38) * d, 0);
      r.lineWidth = size / 300;
      r.beginPath();
      r.arc(c, c, (i / 120) * c, 0, Math.PI * 2);
      r.stroke();
    }
  } else if (plan.pattern === "linen") {
    for (const [dx, dy] of [[1, 0], [0, 1]]) {
      for (let i = 0; i < 160; i++) {
        r.strokeStyle = relief(0.5 + (i % 2 ? 0.28 : -0.28) * d, 0);
        r.lineWidth = size / 420;
        r.beginPath();
        r.moveTo(dx ? (i / 160) * size : 0, dy ? (i / 160) * size : 0);
        r.lineTo(dx ? (i / 160) * size : size, dy ? (i / 160) * size : size);
        r.stroke();
      }
    }
  }
  r.restore();
}

/**
 * Paint one dial into three canvases: the albedo, the lume mask, and the
 * relief map that gives the applied indices, the cut aperture and the stamped
 * finishes their depth.
 *
 * EVERY POSITION COMES FROM `layout`. This painter used to carry its own set
 * of fractions — markers at 0.87, the date window at 0.74, text at 0.17 —
 * while `watch-core.js` carried a second set for its own reasoning, and the
 * two drifted. That drift is what "day clips into date" (feedback #56) was:
 * a GMT numeral under the date window, a facet marker under it, and a day
 * cell painted as its own second window over the date's. The core is now the
 * only place a radius is decided and collision-checks the result over every
 * case × every dial; this function renders that decision and holds no
 * geometry of its own. If a number is needed here that `dialLayout` does not
 * emit, the fix is to emit it — not to guess it back.
 *
 * Radii arrive as fractions of the dial RADIUS and the canvas IS the dial
 * disc, so `polar()` takes a fraction directly and `frac * c` is pixels.
 *
 * @param {any} dial
 * @param {any} layout a `dialLayout()` result — `buildMeshes` returns the very
 *   one it built the hands and the rehaut against, which is what stops a
 *   second call drifting from the first
 * @param {boolean} suppressTrack true when a chapter ring already carries the
 *   minute track, so printing one on the dial as well would double it
 */
function paintDial(dial, layout, suppressTrack) {
  const albedo = texCanvas(TEX);
  const lume = texCanvas(TEX);
  const reliefC = texCanvas(REL);
  const a = albedo.getContext("2d");
  const l = lume.getContext("2d");
  const r = reliefC.getContext("2d");
  // A blank dial rather than a thrown exception if the layout is not the one
  // this painter expects: an exception here aborts setBuild and the watch
  // never mounts at all, which is a much worse failure than an empty plate.
  if (!a || !l || !r || !layout || !layout.markers) return { albedo, lume, relief: reliefC };
  const c = TEX / 2; // pixels per unit of dial RADIUS
  const S = REL / TEX; // the same point, in the relief canvas's space
  const plan = dialRelief(dial);
  l.fillStyle = "#000";
  l.fillRect(0, 0, TEX, TEX);
  r.fillStyle = FLAT;
  r.fillRect(0, 0, REL, REL);

  // --- base finish.
  a.fillStyle = dial.base;
  a.beginPath();
  a.arc(c, c, c, 0, Math.PI * 2);
  a.fill();
  a.save();
  a.beginPath();
  a.arc(c, c, c, 0, Math.PI * 2);
  a.clip();
  if (dial.finish === "sunburst") {
    // The sunburst's LOOK is now the material's radial anisotropy, not paint.
    // What stays painted is the faint tonal variation a real brushed disc has
    // — much weaker than before, because the old version was carrying the
    // whole effect on its own and read as a printed starburst.
    for (let i = 0; i < 360; i++) {
      const ang = (i / 360) * Math.PI * 2;
      a.strokeStyle = `rgba(255,255,255,${0.012 + 0.02 * Math.abs(Math.sin(i * 12.9898))})`;
      a.lineWidth = 2.2;
      a.beginPath();
      a.moveTo(c, c);
      a.lineTo(c + Math.cos(ang) * c, c + Math.sin(ang) * c);
      a.stroke();
    }
  } else if (dial.finish === "fume") {
    const g = a.createRadialGradient(c, c, c * 0.1, c, c, c);
    g.addColorStop(0, "rgba(255,255,255,.20)");
    g.addColorStop(1, "rgba(0,0,0,.78)");
    a.fillStyle = g;
    a.fillRect(0, 0, TEX, TEX);
  } else if (plan.pattern !== "none") {
    // A stamped finish is relief, so the albedo only carries the faint tonal
    // dirt a formed surface picks up; the shading does the rest.
    const rand = rng(0x1d1a1);
    for (let i = 0; i < 900; i++) {
      a.fillStyle = `rgba(${rand() > 0.5 ? "255,255,255" : "0,0,0"},.035)`;
      a.beginPath();
      a.ellipse(rand() * TEX, rand() * TEX, 14 + rand() * 30, 5 + rand() * 8, Math.PI * 0.25, 0, Math.PI * 2);
      a.fill();
    }
  } else if (dial.finish === "gloss") {
    const g = a.createLinearGradient(0, 0, TEX, TEX);
    g.addColorStop(0, "rgba(255,255,255,.06)");
    g.addColorStop(0.5, "rgba(255,255,255,0)");
    g.addColorStop(1, "rgba(0,0,0,.18)");
    a.fillStyle = g;
    a.fillRect(0, 0, TEX, TEX);
  }
  a.restore();
  paintPattern(r, REL, plan);

  const lumeDay = (LUMES[dial.lume] || LUMES.none).day;
  const lumed = dial.lume !== "none";

  // --- minute track. Printed on the dial ONLY when nothing else carries it:
  // where there is a chapter ring, the ring has the track and a second one
  // here would sit a millimetre inside it. The old code passed `true`
  // unconditionally, which is why no dial in the catalogue has ever shown a
  // minute track, chapter ring or not.
  if (!suppressTrack) {
    a.strokeStyle = dial.markerColor;
    a.lineWidth = 3;
    a.globalAlpha = 0.75;
    for (const t of layout.ticks) {
      const [x0, y0] = polar(TEX, t.angle, t.rOuter);
      const [x1, y1] = polar(TEX, t.angle, t.rInner);
      a.beginPath();
      a.moveTo(x0, y0);
      a.lineTo(x1, y1);
      a.stroke();
    }
    a.globalAlpha = 1;
  }

  // --- hour markers. The core has already dropped any that an aperture
  // claims, for every marker style — so this loop skips nothing.
  for (const m of layout.markers) {
    const [cx, cy] = polar(TEX, m.angle, (m.rOuter + m.rInner) / 2);
    const rot = m.angle;
    const h = (m.rOuter - m.rInner) * c;
    // `wid` is a fraction of the dial DIAMETER expressed in millimetres, so
    // the full tangential width in radius units is wid / radius.
    const w = (m.wid / layout.radius) * c;
    const inset = Math.max(2, Math.min(w, h) * 0.14);
    // The truthfulness rule (watch-materials.js §RELIEF): bars, dots,
    // triangles and facets are applied metal on these dials; numerals and
    // Roman numerals are ink and stay dead flat.
    const applied = markerIsApplied(m.kind);
    const cut = plan.sandwich && applied;

    a.save();
    a.translate(cx, cy);
    a.rotate(rot);
    if (m.kind === "dot") {
      a.fillStyle = dial.markerColor;
      a.beginPath();
      a.arc(0, 0, w / 2, 0, Math.PI * 2);
      a.fill();
      if (lumed) {
        a.fillStyle = lumeDay;
        a.beginPath();
        a.arc(0, 0, Math.max(1, w / 2 - inset), 0, Math.PI * 2);
        a.fill();
      }
    } else if (m.kind === "triangle") {
      a.fillStyle = dial.markerColor;
      a.beginPath();
      a.moveTo(0, -h / 2);
      a.lineTo(w * 0.75, h / 2);
      a.lineTo(-w * 0.75, h / 2);
      a.closePath();
      a.fill();
      if (lumed) {
        a.fillStyle = lumeDay;
        a.beginPath();
        a.moveTo(0, -h / 2 + inset * 1.8);
        a.lineTo(w * 0.75 - inset * 1.6, h / 2 - inset);
        a.lineTo(-w * 0.75 + inset * 1.6, h / 2 - inset);
        a.closePath();
        a.fill();
      }
    } else if (m.kind === "numeral" || m.kind === "roman") {
      // `fit` is the core's answer to "VIII" being four glyphs wide in a slot
      // that only owns 30°: the numeral shrinks rather than running into its
      // neighbour.
      a.fillStyle = dial.markerColor;
      a.font = `600 ${Math.max(8, Math.round(h * 0.95 * (m.fit || 1)))}px ui-serif, Georgia, serif`;
      a.textAlign = "center";
      a.textBaseline = "middle";
      a.rotate(-rot);
      a.fillText(m.kind === "roman" ? ROMAN[m.hour] : String(m.hour), 0, 0);
    } else if (m.kind === "facet") {
      // A Grand-Seiko-style faceted marker: two planes meeting on a ridge.
      // The ridge is real relief as well, so the two halves change places as
      // the light moves rather than staying painted on.
      a.fillStyle = dial.markerColor;
      a.fillRect(-w / 2, -h / 2, w, h);
      a.fillStyle = "rgba(255,255,255,.45)";
      a.fillRect(-w / 2, -h / 2, w / 2, h);
    } else {
      a.fillStyle = dial.markerColor;
      a.fillRect(-w / 2, -h / 2, w, h);
      if (lumed) {
        a.fillStyle = lumeDay;
        a.fillRect(-w / 2 + inset, -h / 2 + inset, w - inset * 2, h - inset * 2);
      }
    }
    a.restore();

    // The same marks, white-on-black, into the lume mask.
    if (lumed && applied && m.kind !== "facet") {
      l.save();
      l.translate(cx, cy);
      l.rotate(rot);
      l.fillStyle = "#fff";
      if (m.kind === "dot") {
        l.beginPath();
        l.arc(0, 0, Math.max(1, w / 2 - inset), 0, Math.PI * 2);
        l.fill();
      } else if (m.kind === "triangle") {
        l.beginPath();
        l.moveTo(0, -h / 2 + inset * 1.8);
        l.lineTo(w * 0.75 - inset * 1.6, h / 2 - inset);
        l.lineTo(-w * 0.75 + inset * 1.6, h / 2 - inset);
        l.closePath();
        l.fill();
      } else {
        l.fillRect(-w / 2 + inset, -h / 2 + inset, w - inset * 2, h - inset * 2);
      }
      l.restore();
    }

    // And into the relief map. An applied index is a polished metal frame
    // standing off the plate with the lume filled INSIDE it, so the frame is
    // proud and masked as metal while the fill sits a step lower and stays
    // paint. On a sandwich dial the same shape is a hole instead, with the
    // lume plate visible below the dial's own thickness.
    if (!applied) continue;
    r.save();
    r.translate(cx * S, cy * S);
    r.rotate(rot);
    const rw = w * S;
    const rh = h * S;
    const ri = Math.max(1, inset * S);
    const frameH = cut ? 0.16 : 0.9;
    const fillH = cut ? 0.1 : 0.7;
    if (m.kind === "dot") {
      r.fillStyle = relief(frameH, cut ? 0 : 1);
      r.beginPath();
      r.arc(0, 0, rw / 2, 0, Math.PI * 2);
      r.fill();
      r.fillStyle = relief(fillH, 0);
      r.beginPath();
      r.arc(0, 0, Math.max(0.5, rw / 2 - ri), 0, Math.PI * 2);
      r.fill();
    } else if (m.kind === "triangle") {
      r.fillStyle = relief(frameH, cut ? 0 : 1);
      r.beginPath();
      r.moveTo(0, -rh / 2);
      r.lineTo(rw * 0.75, rh / 2);
      r.lineTo(-rw * 0.75, rh / 2);
      r.closePath();
      r.fill();
      r.fillStyle = relief(fillH, 0);
      r.beginPath();
      r.moveTo(0, -rh / 2 + ri * 1.8);
      r.lineTo(rw * 0.75 - ri * 1.6, rh / 2 - ri);
      r.lineTo(-rw * 0.75 + ri * 1.6, rh / 2 - ri);
      r.closePath();
      r.fill();
    } else if (m.kind === "facet") {
      // One side climbs to the ridge, the other falls away from it — which is
      // exactly what a faceted marker does to light.
      const g = r.createLinearGradient(-rw / 2, 0, rw / 2, 0);
      g.addColorStop(0, relief(0.62, 1));
      g.addColorStop(0.49, relief(0.98, 1));
      g.addColorStop(0.51, relief(0.98, 1));
      g.addColorStop(1, relief(0.62, 1));
      r.fillStyle = g;
      r.fillRect(-rw / 2, -rh / 2, rw, rh);
    } else {
      r.fillStyle = relief(frameH, cut ? 0 : 1);
      r.fillRect(-rw / 2, -rh / 2, rw, rh);
      r.fillStyle = relief(fillH, 0);
      r.fillRect(-rw / 2 + ri, -rh / 2 + ri, rw - ri * 2, rh - ri * 2);
    }
    r.restore();
  }

  // --- GMT 24-hour inner track. A numeral the core marked `skipped` would
  // have been printed under an aperture; it is not printed at all.
  if (layout.gmtTrack) {
    a.fillStyle = dial.markerColor;
    a.font = `500 ${Math.round(layout.gmtTrack.half * 2 * c * 0.95)}px ui-sans-serif, system-ui, sans-serif`;
    a.textAlign = "center";
    a.textBaseline = "middle";
    for (const n of layout.gmtTrack.numerals) {
      if (n.skipped) continue;
      const [x, y] = polar(TEX, n.angle, layout.gmtTrack.r);
      a.fillText(String(n.value), x, y);
    }
  }

  // --- open heart: a window onto the balance. A real cut-out, so it drops.
  if (layout.heart) {
    const [x, y] = polar(TEX, layout.heart.angle, layout.heart.r);
    const rad = layout.heart.radius * c;
    a.fillStyle = "#0a0c10";
    a.beginPath();
    a.arc(x, y, rad, 0, Math.PI * 2);
    a.fill();
    a.strokeStyle = "rgba(200,210,225,.7)";
    a.lineWidth = 6;
    a.stroke();
    a.strokeStyle = "rgba(190,200,215,.5)";
    a.lineWidth = 4;
    for (let i = 1; i <= 3; i++) {
      a.beginPath();
      a.arc(x, y, rad * (i / 4), 0, Math.PI * 2);
      a.stroke();
    }
    r.fillStyle = relief(0.06, 0);
    r.beginPath();
    r.arc(x * S, y * S, rad * S, 0, Math.PI * 2);
    r.fill();
    r.strokeStyle = relief(0.9, 1);
    r.lineWidth = 5;
    r.stroke();
  }

  // --- sub-seconds register: a snailed, recessed disc with its own track.
  if (layout.sub) {
    const [x, y] = polar(TEX, layout.sub.angle, layout.sub.r);
    const rad = layout.sub.radius * c;
    a.save();
    a.fillStyle = "rgba(0,0,0,.16)";
    a.beginPath();
    a.arc(x, y, rad, 0, Math.PI * 2);
    a.fill();
    a.strokeStyle = dial.markerColor;
    a.globalAlpha = 0.55;
    for (let i = 0; i < 60; i++) {
      const ang = (i / 60) * Math.PI * 2;
      const long = i % 5 === 0;
      const [x0, y0] = [x + Math.sin(ang) * rad * 0.98, y - Math.cos(ang) * rad * 0.98];
      const [x1, y1] = [x + Math.sin(ang) * rad * (long ? 0.8 : 0.88), y - Math.cos(ang) * rad * (long ? 0.8 : 0.88)];
      a.lineWidth = long ? 3 : 1.6;
      a.beginPath();
      a.moveTo(x0, y0);
      a.lineTo(x1, y1);
      a.stroke();
    }
    a.restore();
    // Snailing is cut into the plate: fine concentric rings, sunk below it.
    r.save();
    r.fillStyle = relief(0.34, 0);
    r.beginPath();
    r.arc(x * S, y * S, rad * S, 0, Math.PI * 2);
    r.fill();
    r.lineWidth = 1.2;
    for (let i = 1; i < 26; i++) {
      r.strokeStyle = relief(0.34 + (i % 2 ? 0.07 : -0.07), 0);
      r.beginPath();
      r.arc(x * S, y * S, rad * S * (i / 26), 0, Math.PI * 2);
      r.stroke();
    }
    r.strokeStyle = relief(0.9, 1);
    r.lineWidth = 4;
    r.beginPath();
    r.arc(x * S, y * S, rad * S, 0, Math.PI * 2);
    r.stroke();
    r.restore();
  }

  // --- date / day apertures.
  //
  // ONE CUT (docs: the NH36A dial drawing, 7.00 × 2.00 mm centred 8.45 mm out;
  // the NH35A date-only cut is 2.90 × 2.00 mm at 10.55 mm). The line a wearer
  // reads as a divider between the day and the date is not on the dial at all
  // — it is the day DISC's outer edge lying over the date ring underneath. So
  // this paints a single rectangle and places the two cells' glyphs inside it.
  // Painting two windows, which is what the old code did, is what made the day
  // clip into the date.
  //
  // The day is the INBOARD cell. Both cuts share their outer edge to within
  // 0.05 mm, so all of the NH36's extra width is added toward the dial centre:
  // the date keeps the band it occupies on a date-only NH35 and the day is
  // bolted on inside it.
  const wheelBg = dial.wheelBg || "#eef1f5";
  const wheelText = dial.wheelText || "#15181d";
  for (const ap of layout.apertures || []) {
    const [ax, ay] = polar(TEX, ap.angle, ap.r);
    // Rotate so local +X points radially OUTWARD: the cells then run inboard
    // to outboard along +X whatever hour the aperture sits at.
    const phi = ap.angle - Math.PI / 2;
    const rad = ap.w * c;
    const tan = ap.h * c;
    a.save();
    a.translate(ax, ay);
    a.rotate(phi);
    a.fillStyle = wheelBg;
    a.fillRect(-rad / 2, -tan / 2, rad, tan);
    // The disc edge, drawn wherever two cells leave a gap between them. This
    // is the only "divider" there is, and it belongs to the disc.
    const cells = (ap.cells || []).slice().sort((p, q) => p.r - q.r);
    for (let i = 0; i + 1 < cells.length; i++) {
      const x0 = (cells[i].r + cells[i].w / 2 - ap.r) * c;
      const x1 = (cells[i + 1].r - cells[i + 1].w / 2 - ap.r) * c;
      const g = a.createLinearGradient(x0, 0, x1 + 0.001, 0);
      g.addColorStop(0, "rgba(0,0,0,.42)");
      g.addColorStop(1, "rgba(0,0,0,.10)");
      a.fillStyle = g;
      a.fillRect(x0, -tan / 2, Math.max(1.5, x1 - x0), tan);
    }
    a.fillStyle = wheelText;
    a.textAlign = "center";
    a.textBaseline = "middle";
    a.font = `600 ${Math.round(tan * 0.72)}px ui-sans-serif, system-ui, sans-serif`;
    for (const cell of cells) {
      a.save();
      a.translate((cell.r - ap.r) * c, 0);
      // The glyphs read upright however the cut is oriented.
      a.rotate(-phi);
      a.fillText(cell.kind === "date" ? String(new Date().getDate()) : String(cell.sample || ""), 0, 0);
      a.restore();
    }
    a.strokeStyle = dial.markerColor;
    a.lineWidth = 4;
    a.strokeRect(-rad / 2, -tan / 2, rad, tan);
    a.restore();

    r.save();
    r.translate(ax * S, ay * S);
    r.rotate(phi);
    const rr = rad * S;
    const rt = tan * S;
    // An applied polished frame around a hole cut through the plate. The day
    // disc rides ABOVE the date ring, so the two cells sit at two depths and
    // the step between them is the disc edge the albedo just drew.
    r.fillStyle = relief(0.92, 1);
    r.fillRect(-rr / 2 - 4, -rt / 2 - 4, rr + 8, rt + 8);
    r.fillStyle = relief(0.08, 0);
    r.fillRect(-rr / 2, -rt / 2, rr, rt);
    for (const cell of cells) {
      r.fillStyle = relief(cell.kind === "day" ? 0.22 : 0.14, 0);
      r.fillRect(((cell.r - cell.w / 2 - ap.r) * c) * S, -rt / 2, (cell.w * c) * S, rt);
    }
    r.restore();
  }

  // --- printed text. Ink: no relief, ever.
  a.fillStyle = dial.textColor;
  a.textAlign = "center";
  a.textBaseline = "middle";
  const logo = layout.logo || { angle: 0, r: 0.4, size: 0.05 };
  const [lx, ly] = polar(TEX, logo.angle, logo.r);
  a.font = `600 ${Math.round(logo.size * TEX)}px ui-sans-serif, system-ui, sans-serif`;
  // The catalogue may name the dial's brand line (feedback #56 asks for
  // custom text logos); until it does, the house name.
  a.fillText(String(dial.logo || "DeepResearch"), lx, ly);
  for (const line of layout.textLines || []) {
    const [tx, ty] = polar(TEX, line.angle, line.r);
    a.font = `400 ${Math.round(line.size * TEX)}px ui-sans-serif, system-ui, sans-serif`;
    a.fillText(line.text, tx, ty);
  }

  return { albedo, lume, relief: reliefC };
}

/** @type {Record<number, string>} */
const ROMAN = {
  1: "I", 2: "II", 3: "III", 4: "IV", 5: "V", 6: "VI",
  7: "VII", 8: "VIII", 9: "IX", 10: "X", 11: "XI", 12: "XII",
};

/**
 * The bezel insert. `inner` is where the insert's hole starts, as a fraction
 * of the texture radius — the core's annulus UVs put the visible band there.
 *
 * The markings are relief now, and which way they go depends on the
 * substrate: a ceramic insert's scale is laser-etched into the surface and
 * filled, so it sits BELOW; an aluminium insert's is printed on top of the
 * anodising, so it is flat. Getting that backwards is visible immediately.
 * @param {any} insert
 * @param {any} layout
 * @param {number} inner
 * @param {string} materialId
 */
function paintInsert(insert, layout, inner, materialId) {
  const albedo = texCanvas(TEX);
  const lume = texCanvas(TEX);
  const reliefC = texCanvas(REL);
  const a = albedo.getContext("2d");
  const l = lume.getContext("2d");
  const r = reliefC.getContext("2d");
  // A bezel insert is a separately bought part and no longer mandatory
  // (feedback #56), so the bezel may be bare: nothing to paint, and the draw
  // falls back to the bezel's own metal.
  if (!a || !l || !r || !insert) return { albedo, lume, relief: reliefC };
  const c = TEX / 2;
  const S = REL / TEX;
  const etched = materialId === "ceramic" || materialId === "sapphire";
  l.fillStyle = "#000";
  l.fillRect(0, 0, TEX, TEX);
  r.fillStyle = FLAT;
  r.fillRect(0, 0, REL, REL);
  a.fillStyle = insert.base;
  a.fillRect(0, 0, TEX, TEX);

  // Two-colour inserts (Pepsi, Batman, a 24-hour day/night bezel) are split
  // across the 6–12 axis, the first half in base2.
  if (insert.base2) {
    a.fillStyle = insert.base2;
    a.beginPath();
    a.moveTo(c, c);
    a.arc(c, c, TEX, -Math.PI / 2, Math.PI / 2);
    a.closePath();
    a.fill();
  }
  // The painted sheen is gone: gloss is now the ceramic material's own
  // response, and painting a diagonal highlight on top of a real one is
  // exactly the "ugly reflection" the feedback was about.
  if (layout.scale === "none") return { albedo, lume, relief: reliefC };

  const mid = (inner + 1) / 2;
  a.strokeStyle = insert.mark;
  a.fillStyle = insert.mark;
  for (const t of layout.ticks) {
    const long = t.major || t.fine;
    const [x0, y0] = polar(TEX, t.angle, inner + (1 - inner) * (long ? 0.12 : 0.2));
    const [x1, y1] = polar(TEX, t.angle, inner + (1 - inner) * (long ? 0.44 : 0.34));
    a.lineWidth = t.major ? 9 : 5;
    a.beginPath();
    a.moveTo(x0, y0);
    a.lineTo(x1, y1);
    a.stroke();
    if (etched) {
      r.strokeStyle = relief(0.2, 0.35);
      r.lineWidth = (t.major ? 9 : 5) * S;
      r.beginPath();
      r.moveTo(x0 * S, y0 * S);
      r.lineTo(x1 * S, y1 * S);
      r.stroke();
    }
  }
  a.font = `600 ${Math.round(TEX * (1 - inner) * 0.32)}px ui-sans-serif, system-ui, sans-serif`;
  a.textAlign = "center";
  a.textBaseline = "middle";
  if (etched) {
    r.font = `600 ${Math.round(REL * (1 - inner) * 0.32)}px ui-sans-serif, system-ui, sans-serif`;
    r.textAlign = "center";
    r.textBaseline = "middle";
  }
  for (const n of layout.numerals) {
    const [x, y] = polar(TEX, n.angle, mid + (1 - inner) * 0.06);
    a.save();
    a.translate(x, y);
    a.rotate(n.angle);
    a.fillText(String(n.value), 0, 0);
    a.restore();
    if (etched) {
      r.save();
      r.translate(x * S, y * S);
      r.rotate(n.angle);
      r.fillStyle = relief(0.2, 0.35);
      r.fillText(String(n.value), 0, 0);
      r.restore();
    }
  }
  // The lumed pip at zero — the one part of a dive bezel that has to be found
  // in the dark. It is a filled well on every substrate, so it drops on both.
  if (layout.pip) {
    const pipLume = LUMES[insert.pip] || null;
    const [x, y] = polar(TEX, 0, mid + (1 - inner) * 0.05);
    const rad = TEX * (1 - inner) * 0.14;
    a.fillStyle = pipLume ? pipLume.day : insert.mark;
    a.beginPath();
    a.arc(x, y, rad, 0, Math.PI * 2);
    a.fill();
    r.fillStyle = relief(0.86, 1);
    r.beginPath();
    r.arc(x * S, y * S, rad * S + 3, 0, Math.PI * 2);
    r.fill();
    r.fillStyle = relief(0.3, 0);
    r.beginPath();
    r.arc(x * S, y * S, rad * S, 0, Math.PI * 2);
    r.fill();
    if (pipLume) {
      l.fillStyle = "#fff";
      l.beginPath();
      l.arc(x, y, rad, 0, Math.PI * 2);
      l.fill();
    }
  }
  return { albedo, lume, relief: reliefC };
}

/**
 * The chapter ring: a minute track on a cone. Same disc convention. Printed
 * on a metal ring, so there is nothing to raise — its life comes from the
 * radial finish in the material.
 * @param {any} ring
 * @param {number} inner
 */
function paintChapter(ring, inner) {
  const albedo = texCanvas(512);
  const a = albedo.getContext("2d");
  if (!a) return albedo;
  const size = 512;
  a.fillStyle = ring.base;
  a.fillRect(0, 0, size, size);
  a.strokeStyle = ring.mark;
  for (let m = 0; m < 60; m++) {
    const ang = (m / 60) * Math.PI * 2;
    const major = m % 5 === 0;
    const [x0, y0] = polar(size, ang, inner + (1 - inner) * 0.15);
    const [x1, y1] = polar(size, ang, 1);
    a.strokeStyle = ring.accent && m === 15 ? ring.accent : ring.mark;
    a.lineWidth = major ? 5 : 2.5;
    a.beginPath();
    a.moveTo(x0, y0);
    a.lineTo(x1, y1);
    a.stroke();
  }
  return albedo;
}

// ---------------------------------------------------------------------------
// The mount.

/** Object-space axes the material table's `axis` field selects. */
const AXES = [[0, 1, 0], [1, 0, 0], [0, 0, 1]];

/** Mesh keys this renderer places itself; anything else goes through the
 * generic pass, which is how a mesh a geometry module adds (a wrist cylinder,
 * a buckle) shows up without an edit here. */
const PLACED = new Set(["case", "lugs", "crown", "dial", "chapterRing", "insert", "crystal", "caseback", "strap"]);

/** Keep a material's specular tint but let its painted texture supply the
 * albedo. */
function whiteAlbedo(m) {
  m.color = [1, 1, 1];
  return m;
}

/** A direction from an azimuth (0 = +Z, matching the camera's yaw) and an
 * elevation, both in radians. */
function dirAt(az, el) {
  const ce = Math.cos(el);
  return [Math.sin(az) * ce, Math.sin(el), Math.cos(az) * ce];
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ onError?: (msg: string) => void }} [opts]
 */
export function mountWatch(canvas, opts) {
  const gl = /** @type {WebGLRenderingContext | null} */ (
    canvas.getContext("webgl", {
      antialias: true,
      alpha: true,
      // Needed so "Save PNG" can read the frame back after the loop has run.
      preserveDrawingBuffer: true,
    }) || canvas.getContext("experimental-webgl")
  );
  if (!gl) {
    if (opts && opts.onError) opts.onError("no-webgl");
    return null;
  }

  const prog = gl.createProgram();
  if (!prog) return null;
  gl.attachShader(prog, shader(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, shader(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    if (opts && opts.onError) opts.onError(gl.getProgramInfoLog(prog) || "link failed");
    return null;
  }
  gl.useProgram(prog);

  const loc = {};
  for (const n of ["aPos", "aNormal", "aUv"]) loc[n] = gl.getAttribLocation(prog, n);
  for (const n of [
    "uProj", "uView", "uModel", "uNormalMat", "uCam",
    "uSky", "uGround", "uKeyDir", "uKeyCol", "uFillDir", "uFillCol",
    "uRimDir", "uRimCol", "uScene",
    "uColor", "uF0", "uSheenCol", "uGlow", "uAxis",
    "uMat0", "uMat1", "uMat2", "uMat3", "uLogo",
    "uTex", "uLumeTex", "uDetailTex",
  ]) {
    loc[n] = gl.getUniformLocation(prog, n);
  }

  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.BACK);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  /** A 1×1 texture, used wherever a slot is unused. */
  function solidTexture(r, g, b) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([r, g, b, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  const WHITE = solidTexture(255, 255, 255);
  const BLACK = solidTexture(0, 0, 0);
  // Red 128 is "the surface is where the geometry says it is" in the relief
  // encoding, so an unpainted part is flat rather than a crater.
  const NOREL = solidTexture(128, 0, 0);

  /** @param {HTMLCanvasElement} src */
  function canvasTexture(src, existing) {
    const t = existing || gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.generateMipmap(gl.TEXTURE_2D);
    return t;
  }

  /** Upload one core mesh into buffers. */
  function upload(mesh, existing) {
    const b = existing || {
      pos: gl.createBuffer(),
      nor: gl.createBuffer(),
      uv: gl.createBuffer(),
      idx: gl.createBuffer(),
      count: 0,
      radius: 1,
    };
    gl.bindBuffer(gl.ARRAY_BUFFER, b.pos);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(mesh.positions), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.nor);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(mesh.normals), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.uv);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(mesh.uvs), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.idx);
    // Watch meshes stay far under 65 536 vertices, so 16-bit indices are safe
    // and work on WebGL1 without the element-index-uint extension.
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(mesh.indices), gl.STATIC_DRAW);
    b.count = mesh.indices.length;
    // The part's radial extent about its own Y axis. The largest is what the
    // crown's stamped mark normalises against; the smallest is what tells a
    // ring texture where its hole starts. Every mesh in the core is built
    // about Y, so both are read straight off the vertices rather than
    // restated as a formula this file would then have to keep in step.
    let r2 = 0;
    let r2min = Infinity;
    for (let i = 0; i + 2 < mesh.positions.length; i += 3) {
      const d = mesh.positions[i] * mesh.positions[i] + mesh.positions[i + 2] * mesh.positions[i + 2];
      if (d > r2) r2 = d;
      if (d < r2min) r2min = d;
    }
    b.radius = Math.sqrt(r2) || 1;
    b.radiusMin = Number.isFinite(r2min) ? Math.sqrt(r2min) : 0;
    return b;
  }

  // --- scene state -----------------------------------------------------------
  const proj = mat4();
  const view = mat4();
  const model = mat4();
  const nrm = new Float32Array(9);
  let state = {
    /** @type {Record<string, any>} */
    gpu: {},
    /** @type {string[]} */
    meshKeys: [],
    /** @type {Set<string>} */
    meshSet: new Set(),
    /** @type {any[]} */
    hands: [],
    build: null,
    parts: null,
    geo: null,
    dialR: 14.25,
    dialTex: null,
    dialLumeTex: null,
    dialReliefTex: null,
    insertTex: null,
    insertLumeTex: null,
    insertReliefTex: null,
    chapterTex: null,
    /** @type {Record<string, any>} */
    mats: {},
    /** @type {Record<string, string>} */
    meshHints: {},
  };
  let yaw = 0.55;
  let pitch = 0.72;
  let dist = 105;
  let lumeMode = 0;
  let pose = "live"; // "live" or "1010"
  let running = true;

  function setBuild(build) {
    const assembled = buildMeshes(build, { segments: 128 });
    const { parts } = resolveBuild(build);
    const cs = parts.case;
    const plat = PLATFORMS[cs.platform] || PLATFORMS.native;

    state.meshKeys = Object.keys(assembled.meshes);
    // A key from the PREVIOUS build that this one does not produce must stop
    // being drawn; its buffers are still on the GPU and would otherwise leave
    // a bezel insert hanging over a case that no longer has a bezel.
    state.meshSet = new Set(state.meshKeys);
    for (const [key, mesh] of Object.entries(assembled.meshes)) {
      state.gpu[key] = upload(mesh, state.gpu[key]);
    }
    state.hands = assembled.hands.map((h, i) => ({
      ...h,
      gpu: upload(h.mesh, (state.hands[i] || {}).gpu),
    }));
    state.geo = assembled.geo;
    state.dialR = assembled.dialR;
    state.crownTransform = assembled.crownTransform;
    state.parts = parts;
    state.build = build;
    // The geometry modules may publish a mesh-key → material-id map; it wins
    // over the renderer's name heuristic when it is there. This is the seam a
    // new mesh (the leather wrist cylinder, a buckle) arrives through.
    state.meshHints = assembled.materials || {};

    // --- materials, resolved once per build rather than once per frame.
    const finishId = finishMaterialId(parts.finish);
    const insertId = insertMaterialId(parts.insert);
    const strapId = strapMaterialId(parts.strap);
    const crownStyle = String((parts.crown && parts.crown.style) || "coin");
    state.mats = {
      case: materialFor(finishId, parts.finish.color),
      // A caseback is finished more coarsely than the flank and, where it is
      // brushed at all, radially rather than round the case.
      caseback: materialFor(finishId === "steel-polished" ? "steel-polished" : "steel-radial", parts.finish.color),
      // An onion crown's ribs are softer and fewer than a coin edge's, and
      // the core models them the same way — so it takes the fluted response
      // rather than a plain polished one.
      crown: materialFor(
        crownStyle === "coin" ? "crown-knurled" : "crown-fluted",
        parts.finish.color,
      ),
      strap: materialFor(
        parts.strap.kind === "bracelet" && finishId === "steel-polished" ? "bracelet-polished" : strapId,
        parts.strap.color,
      ),
      // The textured parts take their ALBEDO from the painted canvas, so
      // their tint uniform is white — but a partly metallic dial or insert
      // still needs its own colour in the SPECULAR (a blue sunburst dial
      // reflects blue). So the material is built from the part's base colour
      // and only the albedo tint is reset.
      insert: whiteAlbedo(materialFor(insertId, (parts.insert && parts.insert.base) || "#111318")),
      dial: whiteAlbedo(materialFor(dialMaterialId(parts.dial), parts.dial.base)),
      // The rehaut is modelled whether or not a printed chapter ring was
      // bought for it (feedback #56: the ring is not mandatory). Without one
      // it is bare machined steel in the case's own finish.
      chapterRing: parts.chapterRing
        ? whiteAlbedo(materialFor("chapter-ring", parts.chapterRing.base))
        : materialFor("steel-radial", parts.finish.color),
      hands: materialFor("hands-polished", parts.hands.color),
      crystal: crystalMaterial(parts.crystal),
    };
    // A bracelet inherits the case's colour AND its finish family, but its
    // brushing runs along the band, which is circumferential about X — not
    // about Y like the case flank. The material table carries that; this is
    // only where the colour comes from.
    if (parts.strap.kind === "bracelet") {
      state.mats.strap.color = linear(parts.finish.color);
      state.mats.strap.f0 = state.mats.case.f0.slice();
    }
    state.mats.crown.logo = parts.crown && parts.crown.signed ? -1 : 0;

    // Textures.
    //
    // The layout comes from `buildMeshes` rather than from a second
    // `dialLayout()` call: it is the very one the hands were clamped against
    // and the rehaut was built from, and calling it twice is how a painted
    // dial and a modelled one drift apart. It is already carried the case's
    // VISIBLE opening (`apertureR`), which is what keeps an SKX013's 27.5 mm
    // crystal from printing the outside of a 28.5 mm dial under the case lip.
    //
    // A chapter ring carries the minute track, so the dial prints one only
    // when there is no ring — or when the ring the build chose has no track
    // on it. Feedback #56 also asks for the ring to stop being mandatory, so
    // `parts.chapterRing` may be null.
    const ring = parts.chapterRing;
    const ringHasTrack = !!ring && ring.scale !== "none" && ring.track !== false;
    const dl = paintDial(parts.dial, assembled.layout, ringHasTrack);
    state.dialTex = canvasTexture(dl.albedo, state.dialTex);
    state.dialLumeTex = canvasTexture(dl.lume, state.dialLumeTex);
    state.dialReliefTex = canvasTexture(dl.relief, state.dialReliefTex);

    const innerFrac = assembled.insertInner / assembled.insertOuter;
    const il = paintInsert(parts.insert, bezelLayout(parts.insert), innerFrac, insertId);
    state.insertTex = canvasTexture(il.albedo, state.insertTex);
    state.insertLumeTex = canvasTexture(il.lume, state.insertLumeTex);
    state.insertReliefTex = canvasTexture(il.relief, state.insertReliefTex);

    // The rehaut's texture has to start exactly where the cone starts, and
    // the cone's own vertices are the only place that is stated without
    // restating a formula the core owns: its smallest radius over its largest
    // IS the inner fraction its disc UVs use.
    if (ring) {
      const rb = state.gpu.chapterRing;
      const chapInner = rb && rb.radius ? Math.min(0.98, rb.radiusMin / rb.radius) : 0.9;
      state.chapterTex = canvasTexture(paintChapter(ring, chapInner), state.chapterTex);
    } else {
      state.chapterTex = null;
    }

    state.plat = plat;
    // Frame the whole watch including the strap the first time only; a rebuild
    // keeps whatever the viewer had zoomed to.
    if (!state.framed) {
      dist = cs.dims.l2l * 2.3;
      state.framed = true;
    }
  }

  // --- draw helpers ----------------------------------------------------------
  function bindMesh(b) {
    gl.bindBuffer(gl.ARRAY_BUFFER, b.pos);
    gl.enableVertexAttribArray(loc.aPos);
    gl.vertexAttribPointer(loc.aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.nor);
    gl.enableVertexAttribArray(loc.aNormal);
    gl.vertexAttribPointer(loc.aNormal, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.uv);
    gl.enableVertexAttribArray(loc.aUv);
    gl.vertexAttribPointer(loc.aUv, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.idx);
  }

  /**
   * Draw one mesh with one material. `m` is a `materialFor()` result plus the
   * per-draw extras: textures, placement, glow.
   * @param {any} b buffers
   * @param {any} m
   */
  function draw(b, m) {
    if (!b || !b.count || !m) return;
    bindMesh(b);
    const at = m.at || [0, 0, 0];
    modelMatrix(model, m.ry || 0, at[0], at[1], at[2], m.rz || 0);
    normalMatrix(nrm, model);
    gl.uniformMatrix4fv(loc.uModel, false, model);
    gl.uniformMatrix3fv(loc.uNormalMat, false, nrm);
    gl.uniform3fv(loc.uColor, m.color);
    gl.uniform3fv(loc.uF0, m.f0);
    const s = m.sheen || 0;
    const sc = m.sheenColor || [0, 0, 0];
    gl.uniform3f(loc.uSheenCol, sc[0] * s, sc[1] * s, sc[2] * s);
    gl.uniform3fv(loc.uGlow, m.glow || [0, 0, 0]);
    gl.uniform3fv(loc.uAxis, AXES[m.axis || 0] || AXES[0]);
    gl.uniform4f(loc.uMat0, m.rough, m.metal, m.aniso || 0, m.anisoMode || 0);
    gl.uniform4f(loc.uMat1, m.grain || 0, m.grainFreq || 0, m.env === undefined ? 0.25 : m.env, b.radius || 1);
    gl.uniform4f(loc.uMat2, m.coat || 0, m.coatRough || 0.1, m.relief || 0, m.maskRough === undefined ? 0.08 : m.maskRough);
    gl.uniform4f(loc.uMat3, m.alpha === undefined ? 1 : m.alpha, m.tex ? 1 : 0, m.lumeConst || 0, m.glass ? 1 : 0);
    gl.uniform1f(loc.uLogo, m.logo || 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, m.tex || WHITE);
    gl.uniform1i(loc.uTex, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, m.lumeTex || BLACK);
    gl.uniform1i(loc.uLumeTex, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, m.reliefTex || NOREL);
    gl.uniform1i(loc.uDetailTex, 2);
    gl.drawElements(gl.TRIANGLES, b.count, gl.UNSIGNED_SHORT, 0);
  }

  function handAngles(now) {
    if (pose === "1010") {
      // The pose every watch is photographed in: hands clear of the logo and
      // symmetric about 12.
      return { hour: ((10 + 9 / 60) / 12) * Math.PI * 2, minute: (9.5 / 60) * Math.PI * 2, second: (35 / 60) * Math.PI * 2 };
    }
    const d = new Date(now);
    // The NH35 beats at 21 600 A/h — six ticks a second, which is exactly what
    // the seconds hand should do rather than sweeping smoothly.
    const secs = d.getSeconds() + Math.floor((d.getMilliseconds() / 1000) * 6) / 6;
    const mins = d.getMinutes() + secs / 60;
    const hours = (d.getHours() % 12) + mins / 60;
    return {
      hour: (hours / 12) * Math.PI * 2,
      minute: (mins / 60) * Math.PI * 2,
      second: (secs / 60) * Math.PI * 2,
      gmt: ((d.getUTCHours() + d.getUTCMinutes() / 60) / 24) * Math.PI * 2,
    };
  }

  function render(now) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    const bg = lumeMode ? [0.01, 0.012, 0.02] : [0.045, 0.05, 0.065];
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!state.parts) return;

    perspective(proj, (32 * Math.PI) / 180, w / h, 5, 900);
    const cy = Math.cos(pitch);
    const eye = [
      Math.sin(yaw) * cy * dist,
      Math.sin(pitch) * dist,
      Math.cos(yaw) * cy * dist,
    ];
    lookAt(view, eye, [0, state.parts.case.dims.thick / 2, 0], [0, 1, 0]);
    gl.uniformMatrix4fv(loc.uProj, false, proj);
    gl.uniformMatrix4fv(loc.uView, false, view);
    gl.uniform3fv(loc.uCam, eye);

    // THE RIG. The three lights follow the camera's AZIMUTH — key high on the
    // right, fill low and cool on the left, rim behind for the edge — so the
    // build reads from every angle instead of only the default one, which is
    // what feedback #56 hit ("lighting in general looks odd"). The
    // ENVIRONMENT does not follow: its horizon and floor stay put, so the
    // reflections still slide across a polished flank as the watch turns.
    // That split is the whole trick — a rig that rotates with you never has a
    // dead angle, an environment that rotates with you kills the metal.
    gl.uniform3fv(loc.uKeyDir, dirAt(yaw + 0.62, 0.95));
    gl.uniform3fv(loc.uFillDir, dirAt(yaw - 1.25, 0.20));
    gl.uniform3fv(loc.uRimDir, dirAt(yaw + Math.PI + 0.35, 0.55));
    gl.uniform3fv(loc.uKeyCol, lumeMode ? [0.05, 0.055, 0.07] : [2.55, 2.5, 2.38]);
    gl.uniform3fv(loc.uFillCol, lumeMode ? [0.02, 0.024, 0.04] : [0.42, 0.47, 0.58]);
    gl.uniform3fv(loc.uRimCol, lumeMode ? [0.02, 0.026, 0.05] : [0.62, 0.66, 0.78]);
    gl.uniform3fv(loc.uSky, lumeMode ? [0.02, 0.026, 0.045] : [0.60, 0.67, 0.82]);
    gl.uniform3fv(loc.uGround, lumeMode ? [0.004, 0.005, 0.009] : [0.055, 0.052, 0.058]);
    // exposure, lights-out, softbox half-width, floor bounce
    gl.uniform4f(loc.uScene, lumeMode ? 1.7 : 1.12, lumeMode, 0.34, 0.9);

    const p = state.parts;
    const M = state.mats;
    const glowDial = linear((LUMES[p.dial.lume] || LUMES.none).glow);
    const glowPip = linear((LUMES[(p.insert && p.insert.pip)] || LUMES.none).glow);

    gl.depthMask(true);
    gl.disable(gl.BLEND);

    /** The buffers for a key, but only while THIS build still has that mesh. */
    const mesh = (key) => (state.meshSet.has(key) ? state.gpu[key] : null);

    draw(mesh("case"), M.case);
    // Lug tops are brushed along the lug, not around the case.
    draw(mesh("lugs"), { ...M.case, anisoMode: M.case.aniso ? 2 : 0, axis: 2 });
    draw(mesh("caseback"), M.caseback);
    draw(mesh("strap"), M.strap);

    // Crown: the lathe is built around Y, so lay it on its side (rz = 90°) and
    // push it out along the case flank at the catalogue's crown hour. Local
    // −Y is the cap that ends up facing outward, which is where a signed
    // crown's mark goes (M.crown.logo carries the sign).
    const ct = state.crownTransform;
    draw(mesh("crown"), {
      ...M.crown,
      ry: -ct.angle,
      rz: Math.PI / 2,
      at: [ct.x, ct.y, ct.z],
    });

    // The insert only exists on a case with a rotating bezel. Ceramic and
    // anodised aluminium behave nothing alike, which is exactly what the old
    // single half-metal response could not express.
    // No insert bought (feedback #56 — it is not mandatory) means a bare
    // bezel, so the insert disc is not drawn at all rather than drawn blank.
    draw(p.insert ? mesh("insert") : null, {
      ...M.insert,
      tex: state.insertTex,
      lumeTex: state.insertLumeTex,
      reliefTex: state.insertReliefTex,
      relief: 2.0,
      maskRough: 0.12,
      glow: glowPip,
    });

    draw(mesh("dial"), {
      ...M.dial,
      tex: state.dialTex,
      lumeTex: state.dialLumeTex,
      reliefTex: state.dialReliefTex,
      // Applied indices need a strong bevel to read at all; the height field
      // is deliberately gentle so this is the one place it is tuned. The map
      // is mipmapped, so the relief fades out on its own as the watch shrinks
      // rather than turning into aliasing.
      relief: 2.6,
      maskRough: 0.07,
      glow: glowDial,
    });
    draw(mesh("chapterRing"), { ...M.chapterRing, tex: state.chapterTex });

    // Anything a geometry module added that this file does not place itself —
    // the leather wrist cylinder, a buckle, keepers. The material comes from
    // the geometry core's own hint map when it publishes one.
    for (const key of state.meshKeys) {
      if (PLACED.has(key)) continue;
      draw(state.gpu[key], materialFor(meshMaterialId(key, state.meshHints)));
    }

    // Hands, hour first so the seconds hand sits on top.
    const ang = handAngles(now);
    const handGlow = p.hands.lume ? glowDial : [0, 0, 0];
    for (const hand of state.hands) {
      const a = ang[hand.id] === undefined ? 0 : ang[hand.id];
      draw(hand.gpu, {
        ...M.hands,
        color: linear(hand.color),
        ry: Math.PI / 2 - a,
        glow: handGlow,
        lumeConst: p.hands.lume ? 0.55 : 0,
      });
    }

    // The crystal last: blended, and no depth write so the dial keeps showing
    // through the parts of the dome that overlap it.
    gl.enable(gl.BLEND);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    draw(mesh("crystal"), {
      ...M.crystal,
      alpha: !p.crystal || p.crystal.ar === "none" ? 0.1 : 0.03,
    });
    gl.enable(gl.CULL_FACE);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  // --- interaction -----------------------------------------------------------
  /** @type {Map<number, {x:number,y:number}>} */
  const pointers = new Map();
  let pinch = 0;

  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  });
  canvas.addEventListener("pointermove", (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    if (pointers.size === 1) {
      yaw -= (e.clientX - prev.x) * 0.008;
      pitch = Math.max(-1.45, Math.min(1.45, pitch + (e.clientY - prev.y) * 0.008));
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch) dist = Math.max(28, Math.min(420, dist * (pinch / d)));
      pinch = d;
    }
  });
  const release = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = 0;
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("pointerleave", release);
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      dist = Math.max(28, Math.min(420, dist * (1 + Math.sign(e.deltaY) * 0.09)));
    },
    { passive: false },
  );

  let raf = 0;
  function loop(t) {
    if (!running) return;
    render(t);
    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);

  return {
    setBuild,
    /** @param {number|boolean} v falsy = daylight, truthy = lights out */
    setLume(v) {
      lumeMode = v ? 1 : 0;
    },
    /** @param {"live"|"1010"} v */
    setPose(v) {
      pose = v;
    },
    /**
     * Start/stop the draw loop without tearing the GL context down. The /watch/
     * page never needs it — the canvas IS the page — but an inline embed in a
     * chat turn scrolls off screen, and a stack of them each spinning a
     * requestAnimationFrame is how a long conversation gets hot. The chat
     * embed drives this from an IntersectionObserver.
     * @param {boolean} v
     */
    setRunning(v) {
      const want = !!v;
      if (want === running) return;
      running = want;
      if (running) raf = requestAnimationFrame(loop);
      else cancelAnimationFrame(raf);
    },
    resetView() {
      yaw = 0.55;
      pitch = 0.72;
      dist = state.parts ? state.parts.case.dims.l2l * 2.3 : 105;
    },
    /** Straight down on the dial — the catalogue shot. */
    topView() {
      yaw = 0;
      pitch = 1.44;
      dist = state.parts ? state.parts.case.dims.l2l * 1.9 : 90;
    },
    /** @returns {string} a PNG data URL of the current frame */
    toPNG() {
      render(performance.now());
      return canvas.toDataURL("image/png");
    },
    destroy() {
      running = false;
      cancelAnimationFrame(raf);
    },
  };
}
