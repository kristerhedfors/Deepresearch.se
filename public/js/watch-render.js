// The watch builder's RENDERER: the browser half of the /watch/ surface.
// Everything deterministic — the catalogue, the compatibility rules, the
// geometry — lives in the pure core /js/watch-core.js and is Node-tested; this
// module owns the parts a test runner cannot hold: a WebGL context, two
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
// The shading is a small metal model rather than a full PBR pipeline: two
// directional lights, a two-tone environment approximated from the reflected
// vector, a Fresnel rim, and an optional circumferential brush streak. That is
// enough for steel to read as steel, which is the whole job.

import {
  buildMeshes,
  resolveBuild,
  dialLayout,
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

// ---------------------------------------------------------------------------
// Shaders.

const VERT = `
attribute vec3 aPos;
attribute vec3 aNormal;
attribute vec2 aUv;
uniform mat4 uProj, uView, uModel;
uniform mat3 uNormalMat;
varying vec3 vWorld, vNormal, vLocal;
varying vec2 vUv;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vWorld = w.xyz;
  vNormal = uNormalMat * aNormal;
  vLocal = aPos;
  vUv = aUv;
  gl_Position = uProj * uView * w;
}`;

const FRAG = `
precision highp float;
varying vec3 vWorld, vNormal, vLocal;
varying vec2 vUv;
uniform vec3 uColor, uCam, uSky, uGround, uKeyDir, uFillDir, uGlow;
uniform float uRough, uMetal, uAlpha, uBrush, uUseTex, uLume, uLumeConst, uExposure, uGlass;
uniform sampler2D uTex, uLumeTex;
void main() {
  vec3 N = normalize(vNormal);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(uCam - vWorld);
  vec4 tex = uUseTex > 0.5 ? texture2D(uTex, vUv) : vec4(1.0);
  vec3 albedo = uColor * tex.rgb;

  // Circumferential brushing: a cheap angular hash, which is exactly what a
  // lathe-brushed case flank looks like under a moving light.
  float rough = uRough;
  if (uBrush > 0.5) {
    float a = atan(vLocal.z, vLocal.x);
    rough *= 0.74 + 0.5 * abs(sin(a * 24.0));
  }
  rough = clamp(rough, 0.02, 1.0);

  vec3 R = reflect(-V, N);
  float up = R.y * 0.5 + 0.5;
  vec3 env = mix(uGround, uSky, smoothstep(0.0, 1.0, up));
  env += uSky * 0.45 * pow(max(0.0, 1.0 - abs(R.y)), 6.0);

  vec3 L1 = normalize(uKeyDir);
  vec3 L2 = normalize(uFillDir);
  float d1 = max(dot(N, L1), 0.0);
  float d2 = max(dot(N, L2), 0.0);
  float shin = mix(3.0, 260.0, 1.0 - rough);
  float s1 = pow(max(dot(N, normalize(L1 + V)), 0.0), shin);
  float s2 = 0.35 * pow(max(dot(N, normalize(L2 + V)), 0.0), shin);

  vec3 diffuse = albedo * (0.15 + 0.80 * d1 + 0.28 * d2) * (1.0 - 0.72 * uMetal);
  vec3 spec = (s1 + s2) * mix(vec3(1.0), albedo, uMetal) * (1.0 - 0.5 * rough);
  vec3 refl = env * mix(vec3(0.05), albedo, uMetal) * uMetal * (1.0 - 0.6 * rough);
  float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);

  vec3 color = diffuse + spec + refl + env * fres * 0.10 * (1.0 - 0.6 * rough);
  float alpha = uAlpha;

  // Sapphire: almost invisible face-on (that is what anti-reflective coating
  // buys you) and bright at glancing angles, where the dome catches the sky.
  if (uGlass > 0.5) {
    color = albedo * env * (0.35 + 2.2 * fres) + vec3(1.0) * s1 * 2.4;
    alpha = clamp(uAlpha + fres * 0.75 + s1 * 0.9, 0.0, 1.0);
  }

  // Lights out: everything falls away except what was charged.
  color = mix(color, color * 0.03, uLume);
  float lumeMask = max(texture2D(uLumeTex, vUv).r, uLumeConst);
  color += uGlow * lumeMask * (0.10 + 1.9 * uLume);

  color *= uExposure;
  color = color / (color + vec3(1.0));            // Reinhard
  gl_FragColor = vec4(pow(color, vec3(1.0 / 2.2)), alpha);
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

const TEX = 1024;

/** @param {number} size */
function texCanvas(size) {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  return c;
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
 * Paint one dial into a pair of canvases: the albedo, and the lume mask that
 * the "lights out" mode multiplies the glow colour by.
 * @param {any} dial
 * @param {any} layout
 */
function paintDial(dial, layout, hasChapterRing) {
  const albedo = texCanvas(TEX);
  const lume = texCanvas(TEX);
  const a = albedo.getContext("2d");
  const l = lume.getContext("2d");
  if (!a || !l) return { albedo, lume };
  const c = TEX / 2;
  l.fillStyle = "#000";
  l.fillRect(0, 0, TEX, TEX);

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
    // A sunburst is hundreds of fine radial facets catching light differently.
    for (let i = 0; i < 720; i++) {
      const ang = (i / 720) * Math.PI * 2;
      a.strokeStyle = `rgba(255,255,255,${0.02 + 0.05 * Math.abs(Math.sin(i * 12.9898))})`;
      a.lineWidth = 1.6;
      a.beginPath();
      a.moveTo(c, c);
      a.lineTo(c + Math.cos(ang) * c, c + Math.sin(ang) * c);
      a.stroke();
    }
    const g = a.createRadialGradient(c * 0.7, c * 0.6, 0, c, c, c);
    g.addColorStop(0, "rgba(255,255,255,.18)");
    g.addColorStop(1, "rgba(0,0,0,.35)");
    a.fillStyle = g;
    a.fillRect(0, 0, TEX, TEX);
  } else if (dial.finish === "fume") {
    const g = a.createRadialGradient(c, c, c * 0.1, c, c, c);
    g.addColorStop(0, "rgba(255,255,255,.22)");
    g.addColorStop(1, "rgba(0,0,0,.75)");
    a.fillStyle = g;
    a.fillRect(0, 0, TEX, TEX);
  } else if (dial.finish === "textured") {
    // Snowflake-style: a soft directional drift, not a regular pattern.
    for (let i = 0; i < 2600; i++) {
      const x = Math.random() * TEX;
      const y = Math.random() * TEX;
      a.fillStyle = `rgba(${Math.random() > 0.5 ? "255,255,255" : "0,0,0"},.05)`;
      a.beginPath();
      a.ellipse(x, y, 16 + Math.random() * 40, 5 + Math.random() * 9, Math.PI * 0.25, 0, Math.PI * 2);
      a.fill();
    }
  } else if (dial.finish === "gloss") {
    const g = a.createLinearGradient(0, 0, TEX, TEX);
    g.addColorStop(0, "rgba(255,255,255,.10)");
    g.addColorStop(0.5, "rgba(255,255,255,0)");
    g.addColorStop(1, "rgba(0,0,0,.25)");
    a.fillStyle = g;
    a.fillRect(0, 0, TEX, TEX);
  }
  a.restore();

  const lumeDay = (LUMES[dial.lume] || LUMES.none).day;
  const lumed = dial.lume !== "none";

  // --- minute track and hour markers.
  a.strokeStyle = dial.markerColor;
  a.fillStyle = dial.markerColor;
  for (const t of hasChapterRing ? [] : layout.ticks) {
    const [x0, y0] = polar(TEX, t.angle, 0.93);
    const [x1, y1] = polar(TEX, t.angle, 0.885);
    a.lineWidth = 3;
    a.globalAlpha = 0.75;
    a.beginPath();
    a.moveTo(x0, y0);
    a.lineTo(x1, y1);
    a.stroke();
  }
  a.globalAlpha = 1;

  for (const m of layout.markers) {
    const rOuter = 0.87;
    const lenF = m.len / (layout.radius * 2);
    const widF = m.wid / (layout.radius * 2);
    const [cx, cy] = polar(TEX, m.angle, rOuter - lenF / 2);
    const rot = m.angle;
    a.save();
    a.translate(cx, cy);
    a.rotate(rot);
    const w = widF * TEX;
    const h = lenF * TEX;
    if (m.kind === "dot") {
      a.fillStyle = dial.markerColor;
      a.beginPath();
      a.arc(0, 0, w / 2, 0, Math.PI * 2);
      a.fill();
      if (lumed) {
        a.fillStyle = lumeDay;
        a.beginPath();
        a.arc(0, 0, w / 2 - 5, 0, Math.PI * 2);
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
        a.moveTo(0, -h / 2 + 9);
        a.lineTo(w * 0.75 - 8, h / 2 - 5);
        a.lineTo(-w * 0.75 + 8, h / 2 - 5);
        a.closePath();
        a.fill();
      }
    } else if (m.kind === "numeral" || m.kind === "roman") {
      a.fillStyle = dial.markerColor;
      a.font = `600 ${Math.round(h * 0.9)}px ui-serif, Georgia, serif`;
      a.textAlign = "center";
      a.textBaseline = "middle";
      a.rotate(-rot);
      const label = m.kind === "roman" ? ROMAN[m.hour] : String(m.hour);
      a.fillText(label, 0, 0);
    } else if (m.kind === "facet") {
      // A Grand-Seiko-style faceted marker: two tones meeting on a ridge.
      a.fillStyle = dial.markerColor;
      a.beginPath();
      a.moveTo(-w / 2, -h / 2);
      a.lineTo(w / 2, -h / 2);
      a.lineTo(w / 2, h / 2);
      a.lineTo(-w / 2, h / 2);
      a.closePath();
      a.fill();
      a.fillStyle = "rgba(255,255,255,.55)";
      a.beginPath();
      a.moveTo(-w / 2, -h / 2);
      a.lineTo(0, -h / 2);
      a.lineTo(0, h / 2);
      a.lineTo(-w / 2, h / 2);
      a.closePath();
      a.fill();
    } else {
      a.fillStyle = dial.markerColor;
      a.fillRect(-w / 2, -h / 2, w, h);
      if (lumed) {
        a.fillStyle = lumeDay;
        a.fillRect(-w / 2 + 5, -h / 2 + 5, w - 10, h - 10);
      }
    }
    a.restore();

    // The same marks, white-on-black, into the lume mask.
    if (lumed && m.kind !== "numeral" && m.kind !== "roman" && m.kind !== "facet") {
      l.save();
      l.translate(cx, cy);
      l.rotate(rot);
      l.fillStyle = "#fff";
      if (m.kind === "dot") {
        l.beginPath();
        l.arc(0, 0, w / 2 - 5, 0, Math.PI * 2);
        l.fill();
      } else if (m.kind === "triangle") {
        l.beginPath();
        l.moveTo(0, -h / 2 + 9);
        l.lineTo(w * 0.75 - 8, h / 2 - 5);
        l.lineTo(-w * 0.75 + 8, h / 2 - 5);
        l.closePath();
        l.fill();
      } else {
        l.fillRect(-w / 2 + 5, -h / 2 + 5, w - 10, h - 10);
      }
      l.restore();
    }
  }

  // --- GMT 24-hour inner track.
  if (layout.gmt) {
    a.strokeStyle = dial.markerColor;
    a.fillStyle = dial.markerColor;
    a.font = `500 ${Math.round(TEX * 0.045)}px ui-sans-serif, system-ui, sans-serif`;
    a.textAlign = "center";
    a.textBaseline = "middle";
    for (let h = 0; h < 24; h += 2) {
      const ang = (h / 24) * Math.PI * 2;
      const [x, y] = polar(TEX, ang, 0.7);
      a.fillText(String(h), x, y);
    }
  }

  // --- open heart: a window onto the balance.
  if (layout.openHeart) {
    const [x, y] = polar(TEX, (9 / 12) * Math.PI * 2, 0.45);
    a.fillStyle = "#0a0c10";
    a.beginPath();
    a.arc(x, y, TEX * 0.13, 0, Math.PI * 2);
    a.fill();
    a.strokeStyle = "rgba(200,210,225,.7)";
    a.lineWidth = 6;
    a.stroke();
    a.strokeStyle = "rgba(190,200,215,.5)";
    a.lineWidth = 4;
    for (let i = 0; i < 3; i++) {
      a.beginPath();
      a.arc(x, y, TEX * (0.05 + i * 0.03), 0, Math.PI * 2);
      a.stroke();
    }
  }

  // --- date / day apertures.
  if (layout.date === "3") {
    const [x, y] = polar(TEX, (3 / 12) * Math.PI * 2, 0.74);
    const w = TEX * (layout.day ? 0.2 : 0.115);
    const h = TEX * 0.085;
    a.save();
    a.translate(x, y);
    a.fillStyle = "#eef1f5";
    a.fillRect(-w / 2, -h / 2, w, h);
    a.strokeStyle = dial.markerColor;
    a.lineWidth = 4;
    a.strokeRect(-w / 2, -h / 2, w, h);
    a.fillStyle = "#15181d";
    a.font = `600 ${Math.round(h * 0.78)}px ui-sans-serif, system-ui, sans-serif`;
    a.textAlign = "center";
    a.textBaseline = "middle";
    if (layout.day) {
      a.fillText("MON", -w * 0.22, 0);
      a.fillText(String(new Date().getDate()), w * 0.3, 0);
    } else {
      a.fillText(String(new Date().getDate()), 0, 0);
    }
    a.restore();
  }

  // --- printed text.
  a.fillStyle = dial.textColor;
  a.textAlign = "center";
  a.textBaseline = "middle";
  a.font = `600 ${Math.round(TEX * 0.05)}px ui-sans-serif, system-ui, sans-serif`;
  a.fillText("DeepResearch", c, c - TEX * 0.19);
  a.font = `400 ${Math.round(TEX * 0.033)}px ui-sans-serif, system-ui, sans-serif`;
  let ty = c + TEX * 0.17;
  for (const line of layout.text) {
    a.fillText(line, c, ty);
    ty += TEX * 0.045;
  }

  return { albedo, lume };
}

/** @type {Record<number, string>} */
const ROMAN = {
  1: "I", 2: "II", 3: "III", 4: "IV", 5: "V", 6: "VI",
  7: "VII", 8: "VIII", 9: "IX", 10: "X", 11: "XI", 12: "XII",
};

/**
 * The bezel insert. `inner` is where the insert's hole starts, as a fraction
 * of the texture radius — the core's annulus UVs put the visible band there.
 * @param {any} insert
 * @param {any} layout
 * @param {number} inner
 */
function paintInsert(insert, layout, inner) {
  const albedo = texCanvas(TEX);
  const lume = texCanvas(TEX);
  const a = albedo.getContext("2d");
  const l = lume.getContext("2d");
  if (!a || !l) return { albedo, lume };
  const c = TEX / 2;
  l.fillStyle = "#000";
  l.fillRect(0, 0, TEX, TEX);
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
  if (insert.gloss) {
    const g = a.createLinearGradient(0, 0, TEX, TEX);
    g.addColorStop(0, "rgba(255,255,255,.16)");
    g.addColorStop(0.55, "rgba(255,255,255,0)");
    g.addColorStop(1, "rgba(0,0,0,.3)");
    a.fillStyle = g;
    a.fillRect(0, 0, TEX, TEX);
  }
  if (layout.scale === "none") return { albedo, lume };

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
  }
  a.font = `600 ${Math.round(TEX * (1 - inner) * 0.32)}px ui-sans-serif, system-ui, sans-serif`;
  a.textAlign = "center";
  a.textBaseline = "middle";
  for (const n of layout.numerals) {
    const [x, y] = polar(TEX, n.angle, mid + (1 - inner) * 0.06);
    a.save();
    a.translate(x, y);
    a.rotate(n.angle);
    a.fillText(String(n.value), 0, 0);
    a.restore();
  }
  // The lumed pip at zero — the one part of a dive bezel that has to be found
  // in the dark.
  if (layout.pip) {
    const pipLume = LUMES[insert.pip] || null;
    const [x, y] = polar(TEX, 0, mid + (1 - inner) * 0.05);
    const r = TEX * (1 - inner) * 0.14;
    a.fillStyle = pipLume ? pipLume.day : insert.mark;
    a.beginPath();
    a.arc(x, y, r, 0, Math.PI * 2);
    a.fill();
    if (pipLume) {
      l.fillStyle = "#fff";
      l.beginPath();
      l.arc(x, y, r, 0, Math.PI * 2);
      l.fill();
    }
  }
  return { albedo, lume };
}

/**
 * The chapter ring: a minute track on a cone. Same disc convention.
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
    "uProj", "uView", "uModel", "uNormalMat", "uColor", "uCam", "uSky", "uGround",
    "uKeyDir", "uFillDir", "uGlow", "uRough", "uMetal", "uAlpha", "uBrush",
    "uUseTex", "uLume", "uLumeConst", "uExposure", "uGlass", "uTex", "uLumeTex",
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
    /** @type {any[]} */
    hands: [],
    build: null,
    parts: null,
    geo: null,
    dialR: 14.25,
    dialTex: null,
    dialLumeTex: null,
    insertTex: null,
    insertLumeTex: null,
    chapterTex: null,
    caseColor: linear("#a8b0b9"),
    caseRough: 0.45,
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

    // Textures.
    const dl = paintDial(parts.dial, dialLayout(parts.dial, assembled.dialR), true);
    state.dialTex = canvasTexture(dl.albedo, state.dialTex);
    state.dialLumeTex = canvasTexture(dl.lume, state.dialLumeTex);

    const innerFrac = assembled.insertInner / assembled.insertOuter;
    const il = paintInsert(parts.insert, bezelLayout(parts.insert), innerFrac);
    state.insertTex = canvasTexture(il.albedo, state.insertTex);
    state.insertLumeTex = canvasTexture(il.lume, state.insertLumeTex);

    const chapInner = (assembled.dialR - 0.1) / assembled.geo.crystalR;
    state.chapterTex = canvasTexture(paintChapter(parts.chapterRing, chapInner), state.chapterTex);

    state.caseColor = linear(parts.finish.color);
    state.caseRough = parts.finish.rough;
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
   * @param {any} b buffers
   * @param {{color:number[], rough:number, metal:number, alpha?:number, brush?:boolean,
   *          tex?:WebGLTexture|null, lumeTex?:WebGLTexture|null, lumeConst?:number,
   *          glow?:number[], ry?:number, rz?:number, at?:number[]}} mat
   */
  function draw(b, mat) {
    if (!b || !b.count) return;
    bindMesh(b);
    const at = mat.at || [0, 0, 0];
    modelMatrix(model, mat.ry || 0, at[0], at[1], at[2], mat.rz || 0);
    normalMatrix(nrm, model);
    gl.uniformMatrix4fv(loc.uModel, false, model);
    gl.uniformMatrix3fv(loc.uNormalMat, false, nrm);
    gl.uniform3fv(loc.uColor, mat.color);
    gl.uniform1f(loc.uRough, mat.rough);
    gl.uniform1f(loc.uMetal, mat.metal);
    gl.uniform1f(loc.uAlpha, mat.alpha === undefined ? 1 : mat.alpha);
    gl.uniform1f(loc.uBrush, mat.brush ? 1 : 0);
    gl.uniform1f(loc.uUseTex, mat.tex ? 1 : 0);
    gl.uniform1f(loc.uLumeConst, mat.lumeConst || 0);
    gl.uniform1f(loc.uGlass, mat.glass ? 1 : 0);
    gl.uniform3fv(loc.uGlow, mat.glow || [0, 0, 0]);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, mat.tex || WHITE);
    gl.uniform1i(loc.uTex, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, mat.lumeTex || BLACK);
    gl.uniform1i(loc.uLumeTex, 1);
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
    const bg = lumeMode ? [0.01, 0.012, 0.02] : [0.055, 0.065, 0.085];
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
    // A bright sky over a dark floor is what makes steel look like steel: the
    // whole read of a polished flank is that gradient sliding across it.
    gl.uniform3fv(loc.uSky, lumeMode ? [0.03, 0.04, 0.07] : [1.5, 1.62, 1.85]);
    gl.uniform3fv(loc.uGround, lumeMode ? [0.004, 0.005, 0.009] : [0.025, 0.024, 0.028]);
    gl.uniform3fv(loc.uKeyDir, [0.4, 0.88, 0.35]);
    gl.uniform3fv(loc.uFillDir, [-0.65, 0.2, -0.55]);
    gl.uniform1f(loc.uLume, lumeMode);
    gl.uniform1f(loc.uExposure, lumeMode ? 1.6 : 1.15);

    const p = state.parts;
    const metalMat = { color: state.caseColor, rough: state.caseRough, metal: 1, brush: p.finish.id === "brushed" || p.finish.id === "blasted" };
    const glowDial = linear((LUMES[p.dial.lume] || LUMES.none).glow);
    const glowPip = linear((LUMES[p.insert.pip] || LUMES.none).glow);

    gl.depthMask(true);
    gl.disable(gl.BLEND);

    draw(state.gpu.case, metalMat);
    draw(state.gpu.lugs, metalMat);
    draw(state.gpu.caseback, { ...metalMat, rough: Math.min(1, state.caseRough + 0.15) });
    draw(state.gpu.strap, {
      color: linear(p.strap.color),
      rough: p.strap.kind === "bracelet" ? state.caseRough : 0.85,
      metal: p.strap.kind === "bracelet" ? 1 : 0.05,
      brush: p.strap.kind === "bracelet",
    });

    // Crown: the lathe is built around Y, so lay it on its side (rz = 90°) and
    // push it out along the case flank at the catalogue's crown hour.
    const ct = state.crownTransform;
    draw(state.gpu.crown, {
      ...metalMat,
      rough: Math.min(1, state.caseRough + 0.2),
      ry: -ct.angle,
      rz: Math.PI / 2,
      at: [ct.x, ct.y, ct.z],
    });

    // The insert only exists on a case with a rotating bezel.
    draw(state.gpu.insert, {
      color: [1, 1, 1],
      rough: p.insert.gloss ? 0.12 : 0.5,
      metal: 0.15,
      tex: state.insertTex,
      lumeTex: state.insertLumeTex,
      glow: glowPip,
    });

    draw(state.gpu.dial, {
      color: [1, 1, 1],
      rough: p.dial.finish === "gloss" || p.dial.finish === "sunburst" ? 0.18 : 0.6,
      metal: p.dial.finish === "sunburst" || p.dial.finish === "fume" ? 0.55 : 0.1,
      tex: state.dialTex,
      lumeTex: state.dialLumeTex,
      glow: glowDial,
    });
    draw(state.gpu.chapterRing, {
      color: [1, 1, 1],
      rough: 0.4,
      metal: 0.2,
      tex: state.chapterTex,
    });

    // Hands, hour first so the seconds hand sits on top.
    const ang = handAngles(now);
    const handGlow = p.hands.lume ? glowDial : [0, 0, 0];
    for (const hand of state.hands) {
      const a = ang[hand.id] === undefined ? 0 : ang[hand.id];
      draw(hand.gpu, {
        color: linear(hand.color),
        rough: 0.15,
        metal: 0.85,
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
    draw(state.gpu.crystal, {
      color: linear(p.crystal.tint),
      rough: 0.02,
      metal: 0.1,
      alpha: p.crystal.ar === "none" ? 0.16 : 0.05,
      glass: true,
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
