// @ts-check
// The DRC first-visit intro animation: the logotype's Swedish-flag vortex
// (blue disc, twisted yellow arms) — a fleet of them, spinning at different
// sizes — untwists into umbrella canopies, gets its contours drawn and its
// color removed until only a wire drawing remains. The camera then swings a
// quarter circle down from the top view while the now-3D wireframe umbrellas
// hang in the sky — and THEN they turn to life: rich, wildly varying
// VICTORIAN colors flood back into each canopy (every umbrella its own hue),
// gilt ribs gleam over deep gored panels, and beaded fringe unspools and
// dangles, swaying, from every scalloped rim. The umbrella is the tier's own
// symbol: DRC is the sheltered, all-client-side side of the site.
//
// Structured like every DRC module: a PURE core (the timeline parameters and
// the 3D geometry — everything below `playUmbrellaIntro`) that runs in Node
// for the unit suite (public/js/umbrella-intro.test.js), and a DOM layer
// (one fixed canvas, requestAnimationFrame) that only ever runs in the
// browser. No dependencies, no server involvement — the animation is a
// static asset like the rest of the /cure tier.
//
// The whole thing is decoration: tap anywhere to skip, and the caller gates
// it on first visit + prefers-reduced-motion. Nothing downstream awaits it
// for correctness.

// ---- the timeline (pure) -----------------------------------------------------------

// The whole scene runs 2.5× the originally-designed pace (2026-07-12
// directive: the first cut was "a little bit slow"), scaled further by the
// admin's site-config `anim_speed` slider (served publicly at GET
// /api/anim; slider center = 1 = exactly this default). Speed scales the
// CLOCK, not the marks — T below stays the designed shape, and everything
// (phases, spin, sway, sink) hastens uniformly.
export const BASE_SPEED = 2.5;

/** The admin multiplier, defensively: garbage in → the default 1; honest
 * values clamp to [0.25, 4] (the same clamp src/config.js enforces).
 * @param {unknown} v */
export function clampAnimMult(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(4, Math.max(0.25, n));
}

// Phase boundaries in ms of DESIGN time (divide by BASE_SPEED × multiplier
// for wall-clock). One shared clock; every visual parameter below is
// a ramp between two of these marks, so the phases overlap smoothly instead
// of cutting: swirl → untwist → contours drawn while logo color drains → the
// quarter-circle camera drop → the Victorian revival (color floods back,
// each umbrella its own hue) → fringe dangles in → fade.
//
// Kept deliberately tight (T.end < 15000): at the 2.5× base pace the whole
// scene still lands under 6 s of real time (asserted in the unit suite).
export const T = {
  swirlEnd: 2800, // pure logo-vortex spinning & pulsing until here
  untwistEnd: 4900, // arms straighten: vortex → umbrella top view
  wireEnd: 6600, // contours fully drawn
  fillGone: 7500, // logo color fully removed — wire only
  tiltStart: 7500, // camera starts the quarter circle…
  tiltEnd: 10600, // …and is level with the umbrellas here
  reviveStart: 9600, // Victorian color floods back (overlaps the late tilt)…
  reviveEnd: 12400, // …each canopy fully, richly, differently colored
  decoStart: 11000, // beaded fringe unspools from the rims…
  decoEnd: 13200, // …fully hung and swaying
  fadeStart: 13500, // a beat to live, then out
  end: 14700,
};

/** @param {number} v */
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Smoothstep — every ramp uses it so phase edges have no velocity kinks.
 * @param {number} v */
export const smooth = (v) => {
  v = clamp01(v);
  return v * v * (3 - 2 * v);
};

/** @param {number} t @param {number} a @param {number} b */
const ramp = (t, a, b) => smooth((t - a) / (b - a));

/**
 * Every time-driven visual parameter at clock time t (ms).
 * @param {number} t
 * @returns {{twist:number, scallop:number, wire:number, fill:number,
 *           revive:number, deco:number, cam:number, camP:number,
 *           shaft:number, spinRate:number, pulse:number, fade:number,
 *           done:boolean}}
 */
export function paramsAt(t) {
  const camP = ramp(t, T.tiltStart, T.tiltEnd);
  return {
    // 1 = the logo's full vortex twist, 0 = straight umbrella ribs.
    twist: 1 - ramp(t, T.swirlEnd, T.untwistEnd),
    // The scalloped umbrella edge grows in exactly as the twist leaves.
    scallop: ramp(t, T.swirlEnd, T.untwistEnd),
    // Contour drawing progress (ribs → rings → edge, staggered in draw).
    wire: ramp(t, T.untwistEnd, T.wireEnd),
    // Logo panel color; starts draining once the contours are half drawn,
    // gone entirely by fillGone — monotone down, it never returns (the
    // REVIVAL is its own colors, on `revive` below).
    fill: 1 - ramp(t, (T.untwistEnd + T.wireEnd) / 2, T.fillGone),
    // The Victorian revival: rich per-umbrella color flooding into the
    // finished wireframe. 0 through the whole build-up, 1 once fully alive.
    revive: ramp(t, T.reviveStart, T.reviveEnd),
    // Dangling beaded fringe: unspools last, "the decorations in the end".
    deco: ramp(t, T.decoStart, T.decoEnd),
    // Camera pitch: 0 = straight down (top view) … π/2 = side view.
    cam: (camP * Math.PI) / 2,
    camP,
    // Shaft + hook exist only once perspective starts to mean anything.
    shaft: clamp01(camP * 1.8),
    // Spin never stops, but calms from vortex-fast to a lazy umbrella turn.
    spinRate: 1 - 0.7 * ramp(t, T.swirlEnd, T.tiltStart),
    // The size-pulsing of the swirl phase, gone by the wire phase.
    pulse: 1 - ramp(t, T.untwistEnd, T.wireEnd),
    fade: 1 - ramp(t, T.fadeStart, T.end),
    done: t >= T.end,
  };
}

// ---- the geometry (pure) -----------------------------------------------------------

export const PANELS = 8; // 4 yellow + 4 blue, alternating — the untwisted logo
export const MAX_TWIST = 2.35; // radians of arm curl at the canopy edge, twist=1

// A deep, pointed scallop between every rib — the pronounced Victorian
// canopy edge the fringe hangs from (the vortex/logo phase eases into it via
// the growing `scallop` ramp, so the swirl still starts as a clean disc).
export const SCALLOP_DEPTH = 0.15;
// Canopy dome height as a fraction of radius: tall and domed, a Victorian
// pagoda silhouette rather than a flat beach parasol.
export const DOME_FRAC = 0.46;

/** Angular offset of a rib at radius fraction r for a given twist level —
 * the logo's arm curl. Sub-linear in r so the curl concentrates outward,
 * matching the logotype.
 * @param {number} rFrac @param {number} twist */
export function twistOffset(rFrac, twist) {
  return twist * MAX_TWIST * Math.pow(clamp01(rFrac), 0.75);
}

/** Scalloped canopy edge: radius factor across one panel (frac 0..1 rib to
 * rib) — 1 at the ribs, dipping between them as `scallop` grows.
 * @param {number} panelFrac @param {number} scallop @param {number} [depth] */
export function scallopFactor(panelFrac, scallop, depth = 0.085) {
  return 1 - depth * scallop * Math.sin(Math.PI * clamp01(panelFrac));
}

/** Canopy dome height (z, up positive) at radius fraction r: apex at the
 * center, rim at 0.
 * @param {number} rFrac @param {number} domeH */
export function canopyZ(rFrac, domeH) {
  return domeH * (1 - rFrac * rFrac);
}

/** Orthographic camera pitching about the world x-axis. cam=0 looks straight
 * down (top view: screen y = -y); cam=π/2 looks from the side (screen
 * y = -z, i.e. up in the world is up on screen).
 * @param {{x:number, y:number, z:number}} p @param {number} cam
 * @returns {{x:number, y:number}} */
export function project(p, cam) {
  return { x: p.x, y: -(p.y * Math.cos(cam) + p.z * Math.sin(cam)) };
}

// The fleet: a handful of umbrellas in deliberately different sizes, spins
// and directions ("a bunch of them, in different sizes"). fx/fy are
// viewport fractions of the top-view scatter; zLift is how high each one
// hangs in the sky once the camera drops (fraction of the viewport height);
// delay staggers their appearance at the start; `col` is the deep Victorian
// canopy color it wakes up into during the revival — deliberately far apart
// on the wheel so the crowd reads as "very, very varying colors".
export const FLEET = [
  { fx: 0.30, fy: 0.34, s: 0.335, speed: 1.0, dir: 1, phase: 0.0, zLift: 0.55, delay: 0, col: "#9e1f3d" }, // crimson
  { fx: 0.72, fy: 0.24, s: 0.215, speed: 1.35, dir: -1, phase: 1.7, zLift: 0.95, delay: 260, col: "#136b4a" }, // emerald
  { fx: 0.55, fy: 0.64, s: 0.42, speed: 0.8, dir: 1, phase: 3.1, zLift: 0.18, delay: 520, col: "#5a2b86" }, // royal purple
  { fx: 0.15, fy: 0.74, s: 0.175, speed: 1.6, dir: -1, phase: 4.2, zLift: 1.25, delay: 780, col: "#0f5f6e" }, // peacock teal
  { fx: 0.87, fy: 0.68, s: 0.26, speed: 1.15, dir: 1, phase: 2.3, zLift: 0.75, delay: 1040, col: "#6b1226" }, // oxblood
  { fx: 0.43, fy: 0.11, s: 0.145, speed: 1.8, dir: -1, phase: 5.0, zLift: 1.6, delay: 1300, col: "#28356f" }, // indigo
];

// ---- the DOM layer (browser only) --------------------------------------------------

const YELLOW = "#f5c518"; // the logotype's golden swirl
const BLUE = "#1a56b0"; // the logotype's flag-blue field
const INK = "#3d3418"; // drc.css --text: the wire drawing's ink
const KHAKI = "#c3b091"; // drc.css --bg
const GOLD = "#e3c26a"; // gilt rib / brass fringe trim of the revived canopy
const WOOD = "#5b3a1e"; // the handle's polished-wood shaft, once alive

/** "#rrggbb" → [r,g,b]. @param {string} c */
function hex(c) {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
/** @param {number[]} a */
const rgb = (a) => `rgb(${a[0] | 0},${a[1] | 0},${a[2] | 0})`;
/** Linear blend c1→c2 by t∈[0,1]. @param {string} c1 @param {string} c2 @param {number} t */
function lerpCol(c1, c2, t) {
  const a = hex(c1),
    b = hex(c2);
  return rgb([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
}
/** Darken (f<1) / lighten (f>1) a hex color. @param {string} c @param {number} f */
function shade(c, f) {
  const a = hex(c);
  return rgb([Math.min(255, a[0] * f), Math.min(255, a[1] * f), Math.min(255, a[2] * f)]);
}

let playing = false;

/**
 * Plays the intro once over the whole viewport. Resolves the caller via
 * onDone when finished or skipped (tap anywhere). Never throws into the
 * caller — animation failure must not cost a chat. `speed` is the admin
 * multiplier from /api/anim (1 = default; the 2.5× BASE_SPEED is applied
 * here on top of it).
 * @param {{ onDone?: () => void, speed?: number }} [opts]
 */
export function playUmbrellaIntro(opts = {}) {
  const onDone = opts.onDone || (() => {});
  const clockRate = BASE_SPEED * clampAnimMult(opts.speed);
  if (playing || typeof document === "undefined") {
    onDone();
    return;
  }
  playing = true;

  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.cssText =
    "position:fixed;inset:0;z-index:30;width:100%;height:100%;cursor:pointer;" +
    "transition:opacity .3s ease;";
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    canvas.remove();
    playing = false;
    onDone();
    return;
  }

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener("resize", resize);

  // Per-umbrella mutable state: accumulated spin angle (integrated so the
  // spin-rate ramp slows the turn without any angle jump).
  const fleet = FLEET.map((u) => ({ ...u, spin: u.phase * 1.3 }));

  const start = performance.now();
  let last = start;
  let raf = 0;

  // First tap stops and REMOVES the animation immediately — no fade-out to
  // wait through, nothing left in the way of the page underneath.
  canvas.addEventListener("pointerdown", cleanup);

  function cleanup() {
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
    canvas.remove();
    playing = false;
    onDone();
  }

  /** One canopy point through the whole pipeline: local canopy coords →
   * spin → sway → world offset → camera projection → screen px.
   * @param {{x:number,y:number,z:number}} p
   * @param {{cosRX:number,sinRX:number,cosRY:number,sinRY:number,
   *          cx:number,worldY:number,zOff:number,cam:number,H:number}} f */
  function toScreen(p, f) {
    // sway about x, then y (small dangling angles, only in the 3D phase)
    const y1 = p.y * f.cosRX - p.z * f.sinRX;
    const z1 = p.y * f.sinRX + p.z * f.cosRX;
    const x1 = p.x * f.cosRY + z1 * f.sinRY;
    const z2 = -p.x * f.sinRY + z1 * f.cosRY;
    const pr = project({ x: x1, y: f.worldY + y1, z: f.zOff + z2 }, f.cam);
    return { x: f.cx + pr.x, y: f.H * 0.5 + pr.y };
  }

  /** @param {number} now */
  function frame(now) {
    if (!ctx) return cleanup();
    // Design-time clock: real elapsed ms × the speed (BASE_SPEED × the
    // admin multiplier). dt drives the spin integration, so it scales too.
    const dt = Math.min(50, now - last) * clockRate;
    last = now;
    const t = (now - start) * clockRate;
    const P = paramsAt(t);
    if (P.done) return cleanup();

    const W = window.innerWidth;
    const H = window.innerHeight;
    const S = Math.min(W, H);

    // Backdrop: the tier's khaki, with a sky sheen growing from the top as
    // the camera comes level.
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = KHAKI;
    ctx.fillRect(0, 0, W, H);
    if (P.camP > 0) {
      const sky = ctx.createLinearGradient(0, 0, 0, H * 0.7);
      sky.addColorStop(0, `rgba(255,255,255,${0.38 * P.camP})`);
      sky.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, W, H);
    }

    for (const u of fleet) {
      const appear = smooth((t - u.delay) / 500);
      if (appear <= 0) continue;
      u.spin += u.dir * u.speed * P.spinRate * 0.0016 * dt;

      const pulse = 1 + 0.14 * P.pulse * Math.sin(t * 0.0023 * u.speed + u.phase);
      const R = u.s * S * 0.55 * (0.6 + 0.4 * appear) * pulse;
      const domeH = DOME_FRAC * R;
      const swayAmp = 0.11 * P.camP;
      const rx = swayAmp * Math.sin(t * 0.0011 + u.phase);
      const ry = 0.8 * swayAmp * Math.cos(t * 0.0009 + u.phase * 1.4);
      // "Dangle down from the sky": each umbrella lifts to its own height
      // as the camera drops, then sinks slowly for the rest of the scene.
      const sink = t > T.tiltStart ? ((t - T.tiltStart) / 1000) * 0.022 * H : 0;
      const f = {
        cosRX: Math.cos(rx),
        sinRX: Math.sin(rx),
        cosRY: Math.cos(ry),
        sinRY: Math.sin(ry),
        cx: u.fx * W,
        worldY: (0.5 - u.fy) * H * 0.8,
        zOff: u.zLift * P.camP * H * 0.3 - sink,
        cam: P.cam,
        H,
      };

      /** @param {number} rFrac @param {number} theta @param {number} [edgeF] */
      const pt = (rFrac, theta, edgeF) => {
        const a = theta + twistOffset(rFrac, P.twist) + u.spin;
        const r = rFrac * R * (edgeF ?? 1);
        return toScreen(
          { x: r * Math.cos(a), y: r * Math.sin(a), z: canopyZ(rFrac, domeH) },
          f
        );
      };

      const panelA = (2 * Math.PI) / PANELS;

      // -- the gore fill: logo colors, then (post-revival) Victorian ones --
      // One panel outline builder, shared by both color regimes so the
      // scalloped edge stays identical between them.
      /** @param {number} alpha @param {(i:number)=>string} colorOf */
      const fillPanels = (alpha, colorOf) => {
        ctx.globalAlpha = alpha;
        for (let i = 0; i < PANELS; i++) {
          const a0 = i * panelA;
          const a1 = a0 + panelA;
          ctx.beginPath();
          const c = pt(0, a0);
          ctx.moveTo(c.x, c.y);
          for (let k = 1; k <= 8; k++) {
            const p = pt(k / 8, a0);
            ctx.lineTo(p.x, p.y);
          }
          for (let k = 0; k <= 10; k++) {
            const fr = k / 10;
            const p = pt(1, a0 + fr * panelA, scallopFactor(fr, P.scallop, SCALLOP_DEPTH));
            ctx.lineTo(p.x, p.y);
          }
          for (let k = 8; k >= 0; k--) {
            const p = pt(k / 8, a1);
            ctx.lineTo(p.x, p.y);
          }
          ctx.closePath();
          ctx.fillStyle = colorOf(i);
          ctx.fill();
        }
      };

      if (P.fill > 0.01) {
        // The vortex / beach-umbrella logo top: flag blue + golden swirl.
        fillPanels(P.fill * appear, (i) => (i % 2 ? BLUE : YELLOW));
      }
      if (P.revive > 0.01) {
        // Alive: this umbrella's own deep hue, gored two-tone (a darker
        // alternate panel) — the classic Victorian gored canopy.
        const dark = shade(u.col, 0.72);
        fillPanels(smooth(P.revive) * appear, (i) => (i % 2 ? dark : u.col));
      }

      // -- the wire drawing (contours) — gilds as the canopy comes alive ---
      if (P.wire > 0) {
        // Staggered so the contours visibly get DRAWN: ribs first, then the
        // inner rings, then the scalloped edge closes the figure.
        const ribP = clamp01(P.wire / 0.45);
        const ringP = clamp01((P.wire - 0.25) / 0.45);
        const edgeP = clamp01((P.wire - 0.5) / 0.5);
        // Ink while it is only a wire drawing; warms to gilt (thicker) as
        // the Victorian color floods in over it.
        const gild = smooth(P.revive);
        const trim = lerpCol(INK, GOLD, gild);
        ctx.globalAlpha = appear;
        ctx.strokeStyle = trim;
        ctx.lineWidth = Math.max(1, R * (0.014 + 0.009 * gild));
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        if (ribP > 0) {
          for (let i = 0; i < PANELS; i++) {
            const a0 = i * panelA;
            const steps = Math.ceil(12 * ribP);
            ctx.beginPath();
            const c = pt(0, a0);
            ctx.moveTo(c.x, c.y);
            for (let k = 1; k <= steps; k++) {
              const p = pt(Math.min(k / 12, ribP), a0);
              ctx.lineTo(p.x, p.y);
            }
            ctx.stroke();
          }
        }
        // Concentric rib rings — three of them once alive, for an ornate
        // ribbed canopy (the outer two draw during the wire build).
        for (const ringR of [0.4, 0.68, 0.88]) {
          if (ringP <= 0) break;
          // The innermost extra ring only earns its place in the revival.
          if (ringR === 0.4 && gild < 0.15) continue;
          const total = 56;
          const steps = Math.ceil(total * ringP);
          ctx.beginPath();
          const p0 = pt(ringR, 0);
          ctx.moveTo(p0.x, p0.y);
          for (let k = 1; k <= steps; k++) {
            const p = pt(ringR, (k / total) * 2 * Math.PI);
            ctx.lineTo(p.x, p.y);
          }
          ctx.stroke();
        }
        if (edgeP > 0) {
          const perPanel = 10;
          const total = PANELS * perPanel;
          const steps = Math.ceil(total * edgeP);
          ctx.beginPath();
          const p0 = pt(1, 0, scallopFactor(0, P.scallop, SCALLOP_DEPTH));
          ctx.moveTo(p0.x, p0.y);
          for (let k = 1; k <= steps; k++) {
            const panel = Math.floor((k - 1) / perPanel);
            const fr = (k - panel * perPanel) / perPanel;
            const p = pt(1, (panel + fr) * panelA, scallopFactor(fr, P.scallop, SCALLOP_DEPTH));
            ctx.lineTo(p.x, p.y);
          }
          ctx.stroke();
        }

        // -- shaft, finial and crook handle: the third dimension -----------
        if (P.shaft > 0) {
          ctx.globalAlpha = appear * P.shaft;
          // A stout Victorian shaft that warms to polished wood when alive.
          ctx.strokeStyle = lerpCol(INK, WOOD, gild);
          ctx.lineWidth = Math.max(1.4, R * (0.022 + 0.008 * gild));
          const axis = (/** @type {number} */ z) =>
            toScreen({ x: 0, y: 0, z }, f);
          const tip = axis(domeH + 0.2 * R);
          const apex = axis(domeH);
          const bottom = axis(-0.95 * R);
          ctx.beginPath();
          ctx.moveTo(tip.x, tip.y);
          ctx.lineTo(apex.x, apex.y);
          ctx.moveTo(apex.x, apex.y);
          ctx.lineTo(bottom.x, bottom.y);
          ctx.stroke();
          // A brass finial knob at the very top, once gilded.
          if (gild > 0.05) {
            ctx.fillStyle = lerpCol(INK, GOLD, gild);
            ctx.globalAlpha = appear * P.shaft * gild;
            ctx.beginPath();
            ctx.arc(tip.x, tip.y, Math.max(1.4, R * 0.028), 0, 2 * Math.PI);
            ctx.fill();
            ctx.globalAlpha = appear * P.shaft;
            ctx.strokeStyle = lerpCol(INK, WOOD, gild);
          }
          // The J-crook handle, in the plane the spin carries around.
          const hr = 0.13 * R;
          ctx.beginPath();
          let first = true;
          for (let k = 0; k <= 14; k++) {
            const a = Math.PI + (k / 14) * (Math.PI + 0.6);
            const hx = hr + hr * Math.cos(a);
            const hz = -0.95 * R + hr * Math.sin(a);
            const p = toScreen(
              {
                x: hx * Math.cos(u.spin),
                y: hx * Math.sin(u.spin),
                z: hz,
              },
              f
            );
            if (first) {
              ctx.moveTo(p.x, p.y);
              first = false;
            } else ctx.lineTo(p.x, p.y);
          }
          ctx.stroke();
        }

        // -- the dangling decorations: beaded fringe round every rim -------
        // "The decorations in the end": they only unspool once the canopy
        // is alive (deco ramps last) and only read in the tilted 3D view.
        if (P.deco > 0 && P.shaft > 0.15) {
          const strandsPerPanel = 4;
          const maxLen = 0.2 * R;
          const len = maxLen * P.deco;
          ctx.lineCap = "round";
          ctx.strokeStyle = lerpCol(shade(u.col, 0.55), GOLD, 0.55); // brass thread
          ctx.lineWidth = Math.max(1, R * 0.012);
          const tasselR = Math.max(1.4, R * 0.024);
          for (let i = 0; i < PANELS; i++) {
            for (let j = 0; j < strandsPerPanel; j++) {
              const fr = (j + 0.5) / strandsPerPanel;
              const a = (i + fr) * panelA + u.spin;
              const edgeF = scallopFactor(fr, P.scallop, SCALLOP_DEPTH);
              const rr = R * edgeF;
              const bx = rr * Math.cos(a);
              const by = rr * Math.sin(a);
              // A gentle pendulum swing, unique per strand and per umbrella.
              const swing = 0.4 * Math.sin(t * 0.004 + a * 2.6 + u.phase * 1.3);
              const tx = -Math.sin(a); // tangential unit (x)
              const ty = Math.cos(a); // tangential unit (y)
              const rimZ = canopyZ(1, domeH); // 0 — the rim
              const rim = toScreen({ x: bx, y: by, z: rimZ }, f);
              const mid = toScreen(
                { x: bx + swing * len * 0.5 * tx, y: by + swing * len * 0.5 * ty, z: rimZ - len * 0.5 },
                f
              );
              const tip = toScreen(
                { x: bx + swing * len * tx, y: by + swing * len * ty, z: rimZ - len },
                f
              );
              ctx.globalAlpha = appear * P.deco;
              ctx.beginPath();
              ctx.moveTo(rim.x, rim.y);
              ctx.quadraticCurveTo(mid.x, mid.y, tip.x, tip.y);
              ctx.stroke();
              // The tassel bead at the tip.
              ctx.fillStyle = GOLD;
              ctx.beginPath();
              ctx.arc(tip.x, tip.y, tasselR, 0, 2 * Math.PI);
              ctx.fill();
            }
          }
        }
      }
      ctx.globalAlpha = 1;
    }

    // Skip hint.
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = INK;
    ctx.font = "13px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("tap to skip", W / 2, H - 18);
    ctx.globalAlpha = 1;

    canvas.style.opacity = String(P.fade);
    raf = requestAnimationFrame(frame);
  }

  raf = requestAnimationFrame(frame);
}
