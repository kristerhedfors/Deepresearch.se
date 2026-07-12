// @ts-check
// The DRC first-visit intro animation: the logotype's Swedish-flag vortex
// (blue disc, twisted yellow arms) — a fleet of them, spinning at different
// sizes — untwists into beach-umbrella canopies, gets its contours drawn and
// its color removed until only a wire drawing remains, and then the camera
// swings a quarter circle down from the top view while the wireframe
// umbrellas — now fully 3D, shaft and hook included — spin, sway and sink
// slowly out of the sky. The umbrella is the tier's own symbol: DRC is the
// sheltered, all-client-side side of the site.
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

// Phase boundaries in ms. One shared clock; every visual parameter below is
// a ramp between two of these marks, so the phases overlap smoothly instead
// of cutting: swirl → untwist → contours drawn while color drains → the
// quarter-circle camera drop → fade.
export const T = {
  swirlEnd: 3200, // pure logo-vortex spinning & pulsing until here
  untwistEnd: 5800, // arms straighten: vortex → umbrella top view
  wireEnd: 7600, // contours fully drawn
  fillGone: 8600, // color fully removed — wire only
  tiltStart: 8600, // camera starts the quarter circle…
  tiltEnd: 12600, // …and is level with the umbrellas here
  fadeStart: 13600,
  end: 14800,
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
 *           cam:number, camP:number, shaft:number, spinRate:number,
 *           pulse:number, fade:number, done:boolean}}
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
    // Panel color; starts draining once the contours are half drawn.
    fill: 1 - ramp(t, (T.untwistEnd + T.wireEnd) / 2, T.fillGone),
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
// delay staggers their appearance at the start.
export const FLEET = [
  { fx: 0.30, fy: 0.34, s: 0.335, speed: 1.0, dir: 1, phase: 0.0, zLift: 0.55, delay: 0 },
  { fx: 0.72, fy: 0.24, s: 0.215, speed: 1.35, dir: -1, phase: 1.7, zLift: 0.95, delay: 260 },
  { fx: 0.55, fy: 0.64, s: 0.42, speed: 0.8, dir: 1, phase: 3.1, zLift: 0.18, delay: 520 },
  { fx: 0.15, fy: 0.74, s: 0.175, speed: 1.6, dir: -1, phase: 4.2, zLift: 1.25, delay: 780 },
  { fx: 0.87, fy: 0.68, s: 0.26, speed: 1.15, dir: 1, phase: 2.3, zLift: 0.75, delay: 1040 },
  { fx: 0.43, fy: 0.11, s: 0.145, speed: 1.8, dir: -1, phase: 5.0, zLift: 1.6, delay: 1300 },
];

// ---- the DOM layer (browser only) --------------------------------------------------

const YELLOW = "#f5c518"; // the logotype's golden swirl
const BLUE = "#1a56b0"; // the logotype's flag-blue field
const INK = "#3d3418"; // drc.css --text: the wire drawing's ink
const KHAKI = "#c3b091"; // drc.css --bg

let playing = false;

/**
 * Plays the intro once over the whole viewport. Resolves the caller via
 * onDone when finished or skipped (tap anywhere). Never throws into the
 * caller — animation failure must not cost a chat.
 * @param {{ onDone?: () => void }} [opts]
 */
export function playUmbrellaIntro(opts = {}) {
  const onDone = opts.onDone || (() => {});
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

  let start = performance.now();
  let last = start;
  let raf = 0;

  function skip() {
    // Jump the clock to the fade phase instead of cutting — the fade still
    // reveals the page underneath smoothly.
    const t = performance.now() - start;
    if (t < T.fadeStart) start = performance.now() - T.fadeStart;
  }
  canvas.addEventListener("pointerdown", skip);

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
    const dt = Math.min(50, now - last);
    last = now;
    const t = now - start;
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
      const domeH = 0.34 * R;
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

      // -- colored panels (the vortex, then the beach-umbrella top) --------
      if (P.fill > 0.01) {
        ctx.globalAlpha = P.fill * appear;
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
            const p = pt(1, a0 + fr * panelA, scallopFactor(fr, P.scallop));
            ctx.lineTo(p.x, p.y);
          }
          for (let k = 8; k >= 0; k--) {
            const p = pt(k / 8, a1);
            ctx.lineTo(p.x, p.y);
          }
          ctx.closePath();
          ctx.fillStyle = i % 2 ? BLUE : YELLOW;
          ctx.fill();
        }
      }

      // -- the wire drawing (contours), drawn in progressively ------------
      if (P.wire > 0) {
        // Staggered so the contours visibly get DRAWN: ribs first, then the
        // inner rings, then the scalloped edge closes the figure.
        const ribP = clamp01(P.wire / 0.45);
        const ringP = clamp01((P.wire - 0.25) / 0.45);
        const edgeP = clamp01((P.wire - 0.5) / 0.5);
        ctx.globalAlpha = appear;
        ctx.strokeStyle = INK;
        ctx.lineWidth = Math.max(1, R * 0.014);
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
        for (const ringR of [0.45, 0.75]) {
          if (ringP <= 0) break;
          const total = 48;
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
          const p0 = pt(1, 0, scallopFactor(0, P.scallop));
          ctx.moveTo(p0.x, p0.y);
          for (let k = 1; k <= steps; k++) {
            const panel = Math.floor((k - 1) / perPanel);
            const fr = (k - panel * perPanel) / perPanel;
            const p = pt(1, (panel + fr) * panelA, scallopFactor(fr, P.scallop));
            ctx.lineTo(p.x, p.y);
          }
          ctx.stroke();
        }

        // -- shaft, tip and hook: the third dimension ----------------------
        if (P.shaft > 0) {
          ctx.globalAlpha = appear * P.shaft;
          ctx.lineWidth = Math.max(1.2, R * 0.02);
          const axis = (/** @type {number} */ z) =>
            toScreen({ x: 0, y: 0, z }, f);
          const tip = axis(domeH + 0.22 * R);
          const apex = axis(domeH);
          const bottom = axis(-0.95 * R);
          ctx.beginPath();
          ctx.moveTo(tip.x, tip.y);
          ctx.lineTo(apex.x, apex.y);
          ctx.moveTo(apex.x, apex.y);
          ctx.lineTo(bottom.x, bottom.y);
          ctx.stroke();
          // The J-hook, in the plane the spin carries around.
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
