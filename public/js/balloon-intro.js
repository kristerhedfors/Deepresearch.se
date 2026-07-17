// @ts-check
// The Se/rver first-visit intro: the blue tier's counterpart of the DRC
// umbrella intro (public/cure/umbrella.js), speaking the tier's own symbol —
// the BALLOON (FEATURES.md F-16, owner directives 2026-07-15). Same opening
// beat as Se/cure's: the logotype's Swedish-flag vortex (spinning, twisted
// arms) untwists — but here the disc is a balloon CROWN seen from straight
// above, and its contours get drawn while the flag color drains until only a
// wire balloon remains. Then the camera drops a FULL HALF-LAP (180°, twice
// the umbrella's quarter): down past the side view and UNDERNEATH, rolling
// sideways as it descends (the roll crests mid-drop and settles into a
// slightly tilted horizon), while clouds swish upward past the view — the
// relative motion of the descent, the same cloud vocabulary as the balloon
// guide (balloon.js). Color floods back on the way down — FIVE balloons, the
// SAME shape in different sizes (owner's call: sizes vary, the shape does
// not), each in its own blue-and-gold scheme — baskets and rigging fade in
// beneath them, and the view ENDS looking up from below: envelopes overhead,
// burners glowing warm in the mouths. Deliberately FASTER than the umbrella
// intro (~4.1 s real vs ~5.9 s at default speed; asserted in the unit suite).
//
// Structured exactly like umbrella.js: a PURE core (timeline + geometry —
// everything above `playBalloonIntro`, Node-tested in balloon-intro.test.js)
// and a DOM layer (one fixed canvas, requestAnimationFrame) that only runs in
// the browser. The single-balloon renderer (`drawBalloonFigure`) is exported
// so the waiting symbol (balloon-spinner.js) draws the very same figure and
// the two can never drift. Decoration only: tap to skip, wall-clock watchdog,
// every frame wrapped, nothing downstream awaits it.

import { GORES, PALETTE, clamp01, cloudPos, prof, smooth, swishClouds } from "./balloon.js";
import { clampAnimMult, hex, twistOffset } from "../cure/umbrella.js";

export { clampAnimMult }; // re-exported for the caller (same admin multiplier)

// ---- the timeline (pure) -----------------------------------------------------------

// FASTER than the umbrella's 2.5×: a brisker clock AND a tighter timeline.
export const BASE_SPEED = 3.0;

// The reverse-playback easter egg, mirrored from the umbrella intro (its own
// counter key — dr_rver_intro_plays — so the tiers' eggs fire independently).
export const EASTER_EGG_EVERY = 40;
/** @param {number} playCount */
export function easterEggReverse(playCount) {
  return Number.isInteger(playCount) && playCount > 0 && playCount % EASTER_EGG_EVERY === 0;
}

// Phase boundaries in ms of DESIGN time (divide by BASE_SPEED × multiplier for
// wall-clock). One shared clock, every parameter a smooth ramp between marks:
// swirl → untwist → wire drawn while the flag color drains → the 180° camera
// drop (roll cresting mid-way, clouds swishing past, color reviving) → baskets
// rig in → a beat overhead → out. T.end/BASE_SPEED ≈ 4.1 s of real time.
export const T = {
  swirlEnd: 2200, // pure logo-vortex spinning & pulsing until here
  untwistEnd: 3900, // arms straighten: vortex → balloon-crown disc
  wireEnd: 5300, // contours fully drawn (seams → rings → mouth rim)
  fillGone: 6000, // logo color fully removed — wire only
  dropStart: 6000, // the camera starts the half-lap down…
  rollPeak: 8200, // …the sideways twist crests here…
  dropEnd: 9400, // …and it looks straight UP from underneath here
  reviveStart: 7600, // blue-and-gold floods back (overlaps the late drop)
  reviveEnd: 10300, // every envelope fully, richly colored
  rigStart: 8800, // baskets + ropes fade in under the envelopes…
  rigEnd: 10600, // …fully hung
  fadeStart: 11300, // a beat living overhead, then out
  end: 12400,
};

// The sideways camera twist (radians about the view axis): crests at rollPeak,
// then settles into a slightly tilted horizon — the view ends leaning, alive.
export const ROLL_MAX = 0.55;
export const ROLL_END = 0.12;

export { clamp01, smooth }; // the shared easing, re-exported for the spinner

/** @param {number} t @param {number} a @param {number} b */
const ramp = (t, a, b) => smooth((t - a) / (b - a));

/**
 * Every time-driven visual parameter at clock time t (ms).
 * @param {number} t
 * @returns {{twist:number, wire:number, fill:number, revive:number,
 *           rig:number, cam:number, camP:number, roll:number,
 *           spinRate:number, pulse:number, fade:number, done:boolean}}
 */
export function paramsAt(t) {
  const camP = ramp(t, T.dropStart, T.dropEnd);
  return {
    // 1 = the logo's full vortex twist, 0 = straight balloon seams.
    twist: 1 - ramp(t, T.swirlEnd, T.untwistEnd),
    // Contour drawing progress (seams → rings → mouth rim, staggered in draw).
    wire: ramp(t, T.untwistEnd, T.wireEnd),
    // Logo panel color: drains once the contours are half drawn, never returns.
    fill: 1 - ramp(t, (T.untwistEnd + T.wireEnd) / 2, T.fillGone),
    // The revival: each balloon's own blue-and-gold flooding into the wire.
    revive: ramp(t, T.reviveStart, T.reviveEnd),
    // Baskets + rigging, hung in once the underside starts to show.
    rig: ramp(t, T.rigStart, T.rigEnd),
    // Camera pitch: 0 = straight down (top view) … π = straight UP from below.
    cam: camP * Math.PI,
    camP,
    // The sideways twist: up to the crest, then down to the settled lean.
    roll: ROLL_MAX * ramp(t, T.dropStart, T.rollPeak) - (ROLL_MAX - ROLL_END) * ramp(t, T.rollPeak, T.dropEnd),
    // Spin never stops, but calms from vortex-fast to a lazy drift.
    spinRate: 1 - 0.7 * ramp(t, T.swirlEnd, T.dropStart),
    // The size-pulsing of the swirl phase, gone by the wire phase.
    pulse: 1 - ramp(t, T.untwistEnd, T.wireEnd),
    fade: 1 - ramp(t, T.fadeStart, T.end),
    done: t >= T.end,
  };
}

// ---- the geometry (pure) -----------------------------------------------------------

// Envelope proportions shared with the guide (balloon.js): horizontal radius
// prof(s)·R·WIDTH at latitude s (0 crown → 1 mouth), height EH_FRAC·R.
export const WIDTH = 1.35;
export const EH_FRAC = 2.05;

// prof's maximum over [0,1] — the bulge latitude. Used to normalize a
// latitude's radius into the vortex twist's radial fraction, so the twisted
// seams curl exactly like the logo arms (umbrella.js twistOffset).
export const PROF_MAX = (() => {
  let m = 0;
  for (let i = 0; i <= 100; i++) m = Math.max(m, prof(i / 100));
  return m;
})();

/** Envelope z (up positive, world units of R) at latitude s: crown at
 * +EH/2, mouth at −EH/2.
 * @param {number} s @param {number} R */
export function envelopeZ(s, R) {
  return (0.5 - clamp01(s)) * EH_FRAC * R;
}

/** Envelope horizontal radius at latitude s. @param {number} s @param {number} R */
export function envelopeR(s, R) {
  return prof(s) * R * WIDTH;
}

/**
 * Orthographic camera pitching about the world x-axis, 0 = straight down …
 * π = straight up from below (the umbrella's project(), extended past π/2).
 * Returns the screen offset AND the view-depth z' (nearer = larger), which
 * the painter's sort uses.
 * @param {{x:number, y:number, z:number}} p @param {number} cam
 * @returns {{x:number, y:number, d:number}}
 */
export function projectPitch(p, cam) {
  const c = Math.cos(cam);
  const s = Math.sin(cam);
  return { x: p.x, y: -(p.y * c + p.z * s), d: -p.y * s + p.z * c };
}

/**
 * The painter's key for a gore whose mid-longitude is θ (radians, spin
 * included) at camera pitch cam: gores sort ascending by this (far first).
 * Pure so the ordering is unit-testable: at cam=0/π all gores tie (disc
 * views), at side view the −y longitudes come nearest.
 * @param {number} theta @param {number} cam
 */
export function goreDepth(theta, cam) {
  return -Math.sin(theta) * Math.sin(cam);
}

// The fleet: FIVE balloons — the SAME shape (one prof profile for all;
// only `s`, the size, varies — the owner's call), each its own blue-and-gold
// scheme, top-view scatter fx/fy, a zLift for how high it hangs as the camera
// sweeps past the side view, and a stagger delay. col = main gore, alt = the
// alternating gore, border = wire/trim once revived.
export const FLEET = [
  { fx: 0.32, fy: 0.36, s: 0.36, speed: 1.0, dir: 1, phase: 0.0, zLift: 0.5, delay: 0,
    col: PALETTE.gold, alt: PALETTE.blue, border: "#f2f9ff" }, // the logotype pair
  { fx: 0.7, fy: 0.26, s: 0.26, speed: 1.3, dir: -1, phase: 1.7, zLift: 0.95, delay: 220,
    col: "#ffffff", alt: "#4a90d9", border: "#0d4fa0" }, // white & sky
  { fx: 0.54, fy: 0.66, s: 0.21, speed: 0.85, dir: 1, phase: 3.1, zLift: 0.2, delay: 440,
    col: "#0d4fa0", alt: "#e2f1ff", border: PALETTE.gold }, // deep accent, gold trim
  { fx: 0.16, fy: 0.72, s: 0.16, speed: 1.5, dir: -1, phase: 4.2, zLift: 1.25, delay: 660,
    col: "#7db8e8", alt: "#ffffff", border: PALETTE.blue }, // pale blue
  { fx: 0.86, fy: 0.64, s: 0.125, speed: 1.7, dir: 1, phase: 2.3, zLift: 0.75, delay: 880,
    col: "#ffd95e", alt: "#0a2e5c", border: "#ffffff" }, // light gold & ink
];

// ---- the shared single-balloon renderer (browser; used by the spinner too) ---------

const INK = "#0a2e5c"; // app.css --text: the wire drawing's ink
const BASKET = "#a97b46";

/** Linear blend c1→c2 by t. @param {string} c1 @param {string} c2 @param {number} t */
function lerpCol(c1, c2, t) {
  const a = hex(c1);
  const b = hex(c2);
  return `rgb(${(a[0] + (b[0] - a[0]) * t) | 0},${(a[1] + (b[1] - a[1]) * t) | 0},${(a[2] + (b[2] - a[2]) * t) | 0})`;
}

/**
 * Draw ONE balloon figure at screen anchor (cx, cy) — the whole build:
 * twisted vortex gores, the drawn wire, the revival colors, basket + ropes,
 * the from-below burner glow. Works at any camera pitch in [0, π]. Shared by
 * the intro's fleet loop and the waiting symbol so the figure never drifts.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{cx:number, cy:number, R:number,
 *          style:{col:string, alt:string, border:string},
 *          P:ReturnType<typeof paramsAt>, spin:number, sway?:number,
 *          alpha?:number, t?:number}} cfg
 */
export function drawBalloonFigure(ctx, cfg) {
  const { cx, cy, R, style, P, spin } = cfg;
  const A = (cfg.alpha ?? 1) * P.fade;
  if (A <= 0.002) return;
  const t = cfg.t ?? 0;
  const sway = cfg.sway ?? 0;
  const cam = P.cam;
  const cosC = Math.cos(cam);
  const STEPS = 11;

  // A point on the envelope: latitude s, longitude θ (twist curls it by the
  // latitude's radial fraction — the logo-arm law), swayed a little about x.
  // Returns the screen point AND the view depth d (nearer = larger) — the
  // envelope's profile FOLDS at the bulge, so surfaces must be depth-sorted,
  // never filled as one big polygon (nonzero winding cancels the fold).
  /** @param {number} s @param {number} theta
   * @returns {{x:number, y:number, d:number}} */
  const pt = (s, theta) => {
    const rr = envelopeR(s, R);
    const a = theta + twistOffset(rr / (PROF_MAX * R * WIDTH), P.twist) + spin;
    let x = rr * Math.cos(a);
    let y = rr * Math.sin(a);
    let z = envelopeZ(s, R);
    if (sway) {
      const y2 = y * Math.cos(sway) - z * Math.sin(sway);
      z = y * Math.sin(sway) + z * Math.cos(sway);
      y = y2;
    }
    const pr = projectPitch({ x, y, z }, cam);
    return { x: cx + pr.x, y: cy + pr.y, d: pr.d };
  };

  // -- basket + ropes (behind the envelope while looking down) ------------------
  const mouthZ = envelopeZ(1, R);
  const basketZ = mouthZ - 0.5 * R;
  const drawRig = () => {
    if (P.rig <= 0.01) return;
    ctx.globalAlpha = A * P.rig;
    const anchor = projectPitch({ x: 0, y: 0, z: basketZ }, cam);
    const bx = cx + anchor.x;
    const by = cy + anchor.y;
    const bw = R * 0.36;
    const bh = R * 0.26;
    ctx.strokeStyle = INK;
    ctx.lineWidth = Math.max(0.8, R * 0.015);
    // Ropes from four mouth points to the basket's corners.
    ctx.beginPath();
    for (const q of [0, 0.5]) {
      for (const sgn of [-1, 1]) {
        const m = pt(1, q * Math.PI + (sgn === 1 ? 0 : Math.PI));
        ctx.moveTo(m.x, m.y);
        ctx.lineTo(bx + sgn * bw * (q ? 0.32 : 0.5), by - bh / 2);
      }
    }
    ctx.stroke();
    ctx.fillStyle = BASKET;
    ctx.fillRect(bx - bw / 2, by - bh / 2, bw, bh);
    ctx.strokeRect(bx - bw / 2, by - bh / 2, bw, bh);
    ctx.beginPath();
    ctx.moveTo(bx - bw / 2, by - bh / 6);
    ctx.lineTo(bx + bw / 2, by - bh / 6);
    ctx.moveTo(bx - bw / 2, by + bh / 6);
    ctx.lineTo(bx + bw / 2, by + bh / 6);
    ctx.strokeStyle = "rgba(10,46,92,.5)";
    ctx.stroke();
  };
  if (cosC >= 0) drawRig(); // looking down: the basket hangs behind

  // -- the gores, as depth-sorted QUAD STRIPS ------------------------------------
  // The profile folds at the bulge, so each gore is filled as a strip of
  // simple quads (one per latitude step) painted back-to-front — that both
  // avoids the winding-rule fold cancellation AND occludes correctly at
  // every camera pitch (top disc, side, and the from-below view alike).
  const seamA = (2 * Math.PI) / GORES;
  const needFill = P.fill > 0.01 || P.revive > 0.01;
  if (needFill) {
    // Seam samples are shared between adjacent gores — computed once each.
    const seams = [];
    for (let k = 0; k < GORES; k++) {
      const row = [];
      for (let i = 0; i <= STEPS; i++) row.push(pt(i / STEPS, k * seamA));
      seams.push(row);
    }
    const quads = /** @type {{p:{x:number,y:number}[], d:number, k:number, shade:number}[]} */ ([]);
    for (let k = 0; k < GORES; k++) {
      const s0 = seams[k];
      const s1 = seams[(k + 1) % GORES];
      const shade = 0.72 + 0.28 * clamp01(0.5 + goreDepth(k * seamA + seamA / 2 + spin, cam) * 0.9);
      for (let i = 0; i < STEPS; i++) {
        const p = [s0[i], s0[i + 1], s1[i + 1], s1[i]];
        quads.push({ p, d: (p[0].d + p[1].d + p[2].d + p[3].d) / 4, k, shade });
      }
    }
    quads.sort((a, b) => a.d - b.d); // far first
    /** @param {number} a @param {(i:number)=>string} colorOf */
    const fillGores = (a, colorOf) => {
      for (const q of quads) {
        ctx.globalAlpha = a * q.shade;
        ctx.beginPath();
        ctx.moveTo(q.p[0].x, q.p[0].y);
        for (let i = 1; i < 4; i++) ctx.lineTo(q.p[i].x, q.p[i].y);
        ctx.closePath();
        const col = colorOf(q.k);
        ctx.fillStyle = col;
        ctx.fill();
        // Hairline stroke in the fill color closes anti-aliasing gaps
        // between adjacent quads.
        ctx.strokeStyle = col;
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }
    };
    if (P.fill > 0.01) fillGores(P.fill * A, (i) => (i % 2 ? PALETTE.blue : PALETTE.gold));
    if (P.revive > 0.01) {
      fillGores(smooth(P.revive) * A, (i) => (i % 2 ? style.alt : style.col));
    }
  }

  // -- the wire drawing: seams → rings → mouth rim, gilding as it revives -------
  if (P.wire > 0) {
    const seamP = clamp01(P.wire / 0.45);
    const ringP = clamp01((P.wire - 0.25) / 0.45);
    const rimP = clamp01((P.wire - 0.5) / 0.5);
    const gild = smooth(P.revive);
    ctx.globalAlpha = A;
    ctx.strokeStyle = lerpCol(INK, style.border, gild);
    ctx.lineWidth = Math.max(0.8, R * (0.02 + 0.012 * gild));
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (seamP > 0) {
      for (let k = 0; k < GORES; k++) {
        const a0 = k * seamA;
        const steps = Math.ceil(STEPS * seamP);
        ctx.beginPath();
        const c0 = pt(0, a0);
        ctx.moveTo(c0.x, c0.y);
        for (let i = 1; i <= steps; i++) {
          const p = pt(Math.min(i / STEPS, seamP), a0);
          ctx.lineTo(p.x, p.y);
        }
        ctx.stroke();
      }
    }
    for (const ringS of [0.2, 0.42, 0.72]) {
      if (ringP <= 0) break;
      const total = 44;
      const steps = Math.ceil(total * ringP);
      ctx.beginPath();
      const p0 = pt(ringS, 0);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i <= steps; i++) {
        const p = pt(ringS, (i / total) * 2 * Math.PI);
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
    if (rimP > 0) {
      const total = 40;
      const steps = Math.ceil(total * rimP);
      ctx.beginPath();
      const p0 = pt(1, 0);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i <= steps; i++) {
        const p = pt(1, (i / total) * 2 * Math.PI);
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
  }

  // -- the burner, warm in the mouth once alive and seen from beneath -----------
  if (P.revive > 0.4 && cam > Math.PI * 0.6) {
    const up = clamp01((cam / Math.PI - 0.6) / 0.4);
    const m = projectPitch({ x: 0, y: 0, z: mouthZ }, cam);
    const gr = R * 0.5;
    const g = ctx.createRadialGradient(cx + m.x, cy + m.y, 1, cx + m.x, cy + m.y, gr);
    g.addColorStop(0, "rgba(255,240,150,.9)");
    g.addColorStop(0.5, "rgba(245,197,24,.4)");
    g.addColorStop(1, "rgba(245,197,24,0)");
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = A * smooth(P.revive) * up * (0.75 + 0.25 * Math.sin(t * 0.006 + spin));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx + m.x, cy + m.y, gr, 0, 2 * Math.PI);
    ctx.fill();
    ctx.restore();
  }

  if (cosC < 0) drawRig(); // looking up: the basket hangs between us and it
  ctx.globalAlpha = 1;
}

// ---- the DOM layer (browser only) ---------------------------------------------------

const SKY = "#6fc3fd"; // app.css --bg: the blue tier's ground

let playing = false;

/** Resolve whether THIS play runs backwards — the umbrella's easter egg, on
 * the blue tier's own counter. Fail-soft: storage blocked → forwards.
 * @param {{ reverse?: boolean }} opts */
function resolveReverse(opts) {
  if (typeof opts.reverse === "boolean") return opts.reverse;
  try {
    const KEY = "dr_rver_intro_plays";
    const n = (parseInt(localStorage.getItem(KEY) || "0", 10) || 0) + 1;
    localStorage.setItem(KEY, String(n));
    return easterEggReverse(n);
  } catch {
    return false;
  }
}

/**
 * Plays the intro once over the whole viewport — same contract as
 * playUmbrellaIntro: resolves via onDone when finished or skipped (tap),
 * never throws into the caller, `speed` is the admin /api/anim multiplier,
 * `reverse` forces direction (else the easter-egg counter decides).
 * @param {{ onDone?: () => void, speed?: number, reverse?: boolean }} [opts]
 */
export function playBalloonIntro(opts = {}) {
  const onDone = opts.onDone || (() => {});
  const clockRate = BASE_SPEED * clampAnimMult(opts.speed);
  if (playing || typeof document === "undefined") {
    onDone();
    return;
  }
  playing = true;
  const reverse = resolveReverse(opts);

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

  // Per-balloon integrated spin (the spin-rate ramp slows it without a jump)
  // and the descent's swish clouds — one deterministic burst per play.
  const fleet = FLEET.map((u) => ({ ...u, spin: u.phase * 1.3 }));
  const clouds = swishClouds(7, 20260715);

  const start = performance.now();
  let last = start;
  let raf = 0;
  let finished = false;

  canvas.addEventListener("pointerdown", cleanup);

  // Wall-clock watchdog — the same iOS RAF-stall guard the umbrella carries:
  // a correctly-running intro always ends by T.end/clockRate, so if the RAF
  // clock never gets there, force-finish rather than strand a canvas over
  // the app (see umbrella.js for the incident this encodes).
  const maxWall = T.end / clockRate + 1500;
  const watchdog = setTimeout(cleanup, maxWall);

  function cleanup() {
    if (finished) return;
    finished = true;
    clearTimeout(watchdog);
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
    canvas.remove();
    playing = false;
    onDone();
  }

  /** @param {number} now */
  function frame(now) {
    // Any single-frame draw error tears the intro down cleanly — decoration
    // must never strand a full-screen canvas over the app.
    try {
      return drawFrame(now);
    } catch {
      return cleanup();
    }
  }

  /** @param {number} now */
  function drawFrame(now) {
    if (!ctx) return cleanup();
    const prog = (now - start) * clockRate;
    if (prog >= T.end) return cleanup();
    const dt = Math.min(50, now - last) * clockRate * (reverse ? -1 : 1);
    last = now;
    const t = reverse ? T.end - prog : prog;
    const P = paramsAt(t);

    const W = window.innerWidth;
    const H = window.innerHeight;
    const S = Math.min(W, H);

    // Backdrop: the tier's sky, brightening toward the zenith as the camera
    // comes to look straight up into it.
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = SKY;
    ctx.fillRect(0, 0, W, H);
    if (P.camP > 0) {
      const g = ctx.createRadialGradient(W / 2, H / 2, S * 0.1, W / 2, H / 2, S * 0.9);
      g.addColorStop(0, `rgba(255,255,255,${0.42 * P.camP})`);
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }

    // The whole scene — clouds and fleet alike — rides the sideways roll.
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate(P.roll);
    ctx.translate(-W / 2, -H / 2);

    // The descent's clouds: they swish UPWARD past the view while the camera
    // drops (cloudPos runs on camP), the guide's own transition vocabulary.
    if (P.camP > 0.02 && P.camP < 0.98) {
      ctx.fillStyle = "#ffffff";
      for (const c of clouds) {
        const q = cloudPos(c, P.camP);
        if (q <= -0.24 || q >= 1.24) continue;
        const fade = Math.sin(Math.PI * clamp01((q + 0.25) / 1.5));
        const px = c.lane * W;
        const py = (1 - q) * H; // bottom → top: the camera drops, so the clouds rise past the view
        ctx.globalAlpha = 0.7 * fade;
        for (const [dx, dy, rr] of [[-0.8, 0, 0.72], [0, -0.4, 1], [0.85, 0, 0.66]]) {
          const r = S * 0.05 * c.scale;
          ctx.beginPath();
          ctx.arc(px + dx * r, py + dy * r, rr * r, 0, 2 * Math.PI);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    }

    for (const u of fleet) {
      const appear = smooth((t - u.delay) / 400);
      if (appear <= 0) continue;
      u.spin += u.dir * u.speed * P.spinRate * 0.0016 * dt;

      const pulse = 1 + 0.14 * P.pulse * Math.sin(t * 0.0023 * u.speed + u.phase);
      const R = u.s * S * 0.55 * (0.6 + 0.4 * appear) * pulse;
      // Anchor: top-view scatter → hangs high past the side view (zLift) →
      // the mirrored from-below scatter. Ortho pitch on the anchor itself.
      const wy = (0.5 - u.fy) * H * 0.8;
      const zo = u.zLift * P.camP * H * 0.28;
      const sy = H * 0.5 - (wy * Math.cos(P.cam) + zo * Math.sin(P.cam));
      const sway = 0.1 * Math.sin(P.camP * Math.PI) * Math.sin(t * 0.0011 + u.phase);
      drawBalloonFigure(ctx, {
        cx: u.fx * W,
        cy: sy,
        R,
        style: u,
        P,
        spin: u.spin,
        sway,
        alpha: appear,
        t,
      });
    }

    ctx.restore();

    // Skip hint.
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = INK;
    ctx.font = "13px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("tap to skip", W / 2, H - 18);
    ctx.globalAlpha = 1;

    canvas.style.opacity = String(reverse ? Math.min(P.fade, smooth(t / 700)) : P.fade);
    raf = requestAnimationFrame(frame);
  }

  raf = requestAnimationFrame(frame);
}
