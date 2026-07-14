// @ts-check
// The umbrella SPINNER: the DRC first-visit intro (public/cure/umbrella.js),
// shrunk to a single umbrella and looped in place, standing in for the old
// "twirly site logo spinning back and forth" loading indicators of the main
// app (the `.spin` step markers and the `.typing-icon`, css/app.css). Instead
// of a flat icon rocking on a CSS keyframe, each loading slot now plays the
// whole intro in miniature, FIXED in its position: the logo-vortex swirls,
// untwists into a canopy, its contours get drawn while the flag color drains,
// the camera swings a quarter lap so the now-3D wireframe hangs, and then
// white-and-pink color floods back into the canopy which dangles a beaded
// fringe — the same beats as the intro, on a tight ~6 s loop. Two loading
// slots side by side get two different umbrella STYLES (color + shape), just
// like the intro's varied fleet.
//
// It REUSES the intro's pure timeline + geometry (umbrella.js) verbatim so the
// two never drift; only the DOM/draw layer here is new, and it is a trimmed
// single-umbrella version of the intro's fleet renderer. Pure and browser
// glue are split the same way umbrella.js is: the two exported helpers below
// (loopedDesignTime, spinnerStyle) run in Node for the unit suite
// (umbrella-spinner.test.js); mountUmbrellaSpinner only ever runs in a browser.
//
// Entirely decoration and entirely fail-soft: any failure leaves the caller's
// original CSS spinner untouched (mount is best-effort), and a detached host
// stops the animation on its own — nothing downstream awaits it.

import {
  BASE_SPEED,
  clampAnimMult,
  clamp01,
  smooth,
  paramsAt,
  T,
  twistOffset,
  scallopFactor,
  project,
  FLEET,
  PANELS,
  DOME_FRAC,
  SCALLOP_DEPTH,
} from "../cure/umbrella.js";

// ---- pure helpers (Node-tested) ----------------------------------------------------

// The in-progress LOOP turns back JUST BEFORE the pink. Its apex is the moment
// the umbrella is fully built, tilted and wobbling but the Victorian color has
// NOT yet flooded in — revive is exactly 0 at T.reviveStart. So while work is
// ongoing the loading symbol swirls → untwists → wireframes → tilts → wobbles,
// then rewinds, over and over, and NEVER blooms pink. Only the completion
// FINALE (planFinale below) crosses T.reviveStart into the pink revive: the
// pink umbrella is the one beat the loop never reaches, reserved for "done".
export const LOOP_APEX = T.reviveStart;

// The finale's target: the fully-revived, fully-fringed PINK umbrella — held a
// beat, then folded into the ✓. Past reviveEnd and decoEnd but before the
// intro's own fade, so it's the richest pink with its fringe fully hung.
export const PINK_APEX = T.decoEnd;

/** The BOOMERANG clock: real elapsed ms → design-time t that ramps 0→cycle
 * then back cycle→0, forever — a triangle wave. So the spinner plays the intro
 * (vortex→untwist→wire→camera→wobble) FORWARD, then rewinds it BACKWARD, over
 * and over: the loading symbol "goes back and forth" like a boomerang while the
 * host stays mounted. The default cycle is LOOP_APEX (T.reviveStart), so the
 * apex is the built-but-still-colorless wobbling umbrella JUST BEFORE the pink
 * revive — the turn is a clean reversal, and the pink is saved for the finale.
 * @param {number} elapsedReal  ms since mount (real time)
 * @param {number} clockRate    design-ms per real-ms (BASE_SPEED × admin mult)
 * @param {number} cycle        design-ms of one one-way sweep (half the period)
 * @returns {number} */
export function boomerangDesignTime(elapsedReal, clockRate, cycle = LOOP_APEX) {
  const c = cycle > 0 ? cycle : LOOP_APEX;
  const pos = (Math.max(0, elapsedReal) * clockRate) % (2 * c);
  return pos <= c ? pos : 2 * c - pos;
}

/** The style for the i-th loading slot on screen: one of the intro fleet's
 * canopies (its pink/white colors + dome/pagoda/scallop shape), cycled so
 * adjacent slots differ. Defensive against a non-integer/negative index.
 * @param {number} index
 * @returns {typeof FLEET[number]} */
export function spinnerStyle(index) {
  const n = FLEET.length;
  const i = Number.isFinite(index) ? ((Math.trunc(index) % n) + n) % n : 0;
  return FLEET[i];
}

// ---- the completion FINALE (pure) --------------------------------------------------
// When the task finishes, the spinner stops boomeranging and SPEED-RUNS from
// wherever it was caught on the wave, forward through the remaining motion and
// INTO the pink umbrella (the one place the loop never reaches), holds a beat,
// then folds into the ✓. There are FIVE versions keyed to where the wave was
// caught — the phase bucket picks the runway so a catch deep in the vortex
// still lands the pink umbrella at the same satisfying felt pace as one already
// tilting; the further out it was, the more design-time it fast-forwards.

// Phase boundaries within the loop, in DESIGN ms. A catch before the first mark
// is bucket 0 (deep vortex, furthest from pink); at/after the last is bucket 4
// (built, tilted & wobbling — nearly there).
const FINALE_MARKS = [T.swirlEnd, T.untwistEnd, T.wireEnd, T.tiltStart];
// Real-ms runway per bucket (index = bucket): further out → longer runway, so
// the bigger design-distance still reads as a deliberate speed-run, not a snap.
const FINALE_RUN_MS = [900, 760, 640, 520, 400];
const FINALE_HOLD_MS = 240; // living a beat as the pink umbrella
const FINALE_CHECK_MS = 420; // the pink umbrella folding into the ✓

/** Which of the five speed-run versions a completion caught at design-time t0
 * uses (0 = deep vortex … 4 = tilted & wobbling).
 * @param {number} t0 @returns {number} */
export function finalePhaseBucket(t0) {
  const t = Number.isFinite(t0) ? Math.max(0, t0) : 0;
  let b = 0;
  for (const m of FINALE_MARKS) if (t >= m) b++;
  return b;
}

/** The finale plan for a completion caught at design-time t0 (the current wave
 * position): the speed-run from t0 up to the pink apex, the beat to hold it,
 * and the fold into the ✓. Pure and deterministic — the browser just plays it
 * out frame by frame.
 * @param {number} t0
 * @returns {{bucket:number, runStart:number, runEnd:number, runMs:number,
 *            holdMs:number, checkMs:number, totalMs:number}} */
export function planFinale(t0) {
  const start = Number.isFinite(t0) ? Math.min(Math.max(0, t0), PINK_APEX) : 0;
  const bucket = finalePhaseBucket(start);
  const runMs = FINALE_RUN_MS[bucket];
  return {
    bucket,
    runStart: start,
    runEnd: PINK_APEX,
    runMs,
    holdMs: FINALE_HOLD_MS,
    checkMs: FINALE_CHECK_MS,
    totalMs: runMs + FINALE_HOLD_MS + FINALE_CHECK_MS,
  };
}

// ---- the DOM layer (browser only) --------------------------------------------------

const YELLOW = "#f5c518"; // the logotype's golden swirl
const BLUE = "#1a56b0"; // the logotype's flag-blue field
const INK = "#3d3418"; // the wire drawing's ink (drc.css --text)
const CREAM = "#fff4f8"; // the fringe tassels of the revived rim
const HANDLE = "#9c6472"; // the handle's dusty-rose shaft once alive
const CHECK_PINK = "#e06c8c"; // the finale's ✓ — the fleet rose, matching the
// CSS `.check` (--check-pink / --pink) so the canvas ✓ hands off seamlessly.

/** "#rrggbb" → [r,g,b]. @param {string} c */
function hex(c) {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
/** @param {number[]} a */
const rgb = (a) => `rgb(${a[0] | 0},${a[1] | 0},${a[2] | 0})`;
/** Linear blend c1→c2 by t. @param {string} c1 @param {string} c2 @param {number} t */
function lerpCol(c1, c2, t) {
  const a = hex(c1),
    b = hex(c2);
  return rgb([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
}

/** Is a canvas 2D context available at all? Node/SSR/old browsers → no. */
function canCanvas() {
  return typeof document !== "undefined" && !!document.createElement("canvas").getContext;
}

/** prefers-reduced-motion: honor it — decoration must never override that. */
function reducedMotion() {
  return (
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Replace a small loading slot with a looping single-umbrella animation.
 * The host keeps its layout box; the canvas is centered and allowed to
 * overflow so the tilted canopy + hanging shaft aren't clipped. Best-effort:
 * on reduced-motion or no-canvas it leaves the host's CSS spinner as-is and
 * returns a no-op handle. The animation stops itself once the host leaves
 * the document (the existing `.spin`/`.typing-icon` removal is all the
 * cleanup callers need).
 *
 * @param {HTMLElement} host  the `.spin` / `.typing-icon` element
 * @param {{ size?: number, style?: number, speed?: number }} [opts]
 *   size  — the drawing box in px (defaults to ~2.4× the host's rendered size)
 *   style — which fleet canopy (see spinnerStyle); adjacent slots pass 0,1,…
 *   speed — the admin anim multiplier (1 = default; BASE_SPEED applied on top)
 * @returns {{ stop: () => void, finish: (onDone?: () => void) => void }}
 *   stop   — tear down immediately (no finale), for cancel/settle paths.
 *   finish — play the completion finale (speed-run into the pink umbrella, then
 *            fold into the ✓) and call onDone ONCE when the ✓ has formed; the
 *            caller swaps in its real checkmark then. On a no-op mount it fires
 *            onDone immediately so the caller still gets its checkmark.
 */
export function mountUmbrellaSpinner(host, opts = {}) {
  const noop = {
    stop: () => {},
    /** @param {(() => void)=} onDone */
    finish: (onDone) => {
      if (typeof onDone === "function") onDone();
    },
  };
  try {
    if (!host || !canCanvas() || reducedMotion()) return noop;

    // The host stays its own size in the flow; the canvas is bigger and
    // centered over it, so the umbrella can dangle past the icon slot.
    const hostBox = host.getBoundingClientRect();
    const base = Math.max(hostBox.width, hostBox.height) || 32;
    const size = Math.round(opts.size || base * 2.4);
    const style = spinnerStyle(opts.style ?? 0);
    const clockRate = BASE_SPEED * clampAnimMult(opts.speed);

    // Neutralize the CSS twirly-logo look; the canvas is the indicator now.
    host.style.background = "none";
    host.style.animation = "none";
    host.style.position = host.style.position || "relative";
    host.style.overflow = "visible";

    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.cssText =
      "position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);" +
      `width:${size}px;height:${size}px;pointer-events:none;`;
    host.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      canvas.remove();
      return noop;
    }
    const dpr = Math.min(2, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const R = size * 0.3; // canopy radius; leaves room for the hanging shaft
    const cx = size / 2;
    const cy = size * 0.44; // anchor a touch high so the shaft hangs into view
    const domeFrac = style.dome ?? DOME_FRAC;
    const sc = style.scallop ?? SCALLOP_DEPTH;
    const pg = clamp01(style.pagoda ?? 0);

    let spin = 0; // integrated so the spin-rate ramp never jumps the angle
    let raf = 0;
    let start = 0;
    let lastT = 0; // previous design-time — its signed delta drives spin
    let stopped = false;

    // Completion FINALE state: set by finish(), played out in frame(). While
    // `mode` is "loop" the boomerang runs; once "finale", the spinner speed-runs
    // into the pink umbrella and folds into the ✓ per the pure planFinale plan.
    let mode = /** @type {"loop"|"finale"} */ ("loop");
    let finaleStart = 0; // real ms when the finale's first frame ran
    let plan = /** @type {ReturnType<typeof planFinale>|null} */ (null);
    let onFinaleDone = /** @type {(() => void)|null} */ (null);
    let doneCalled = false;

    function stop() {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      canvas.remove();
    }

    /** Begin the completion finale: from wherever the wave was caught (the last
     * drawn design-time), speed-run forward into the pink umbrella, hold a beat,
     * then fold into the ✓ — `onDone` fires ONCE when the ✓ has formed. Idempotent
     * (a second call only re-points onDone); a stopped spinner fires onDone at once.
     * @param {(() => void)=} onDone */
    function finish(onDone) {
      const cb = typeof onDone === "function" ? onDone : null;
      if (stopped) {
        if (cb) cb();
        return;
      }
      if (mode === "finale") {
        if (cb) onFinaleDone = cb;
        return;
      }
      onFinaleDone = cb;
      plan = planFinale(lastT); // lastT = where the boomerang is right now
      finaleStart = 0;
      mode = "finale";
    }

    /** One canopy point → sway → camera projection → screen px.
     * @param {{x:number,y:number,z:number}} p
     * @param {{cosRX:number,sinRX:number,cosRY:number,sinRY:number,
     *          zOff:number,cam:number}} f */
    function toScreen(p, f) {
      const y1 = p.y * f.cosRX - p.z * f.sinRX;
      const z1 = p.y * f.sinRX + p.z * f.cosRX;
      const x1 = p.x * f.cosRY + z1 * f.sinRY;
      const z2 = -p.x * f.sinRY + z1 * f.cosRY;
      const pr = project({ x: x1, y: y1, z: f.zOff + z2 }, f.cam);
      return { x: cx + pr.x, y: cy + pr.y };
    }

    /** Draw the umbrella at design-time t with master alpha A (fade-in × the
     * timeline's own P.fade). Clears the canvas first. `fold` (0..1) collapses
     * it toward center as it dissolves into the ✓ during the finale. Reads the
     * closure's `spin` (updated once per frame in frame()).
     * @param {number} t @param {number} A @param {number} fold */
    function drawUmbrella(t, A, fold) {
      if (!ctx) return;
      ctx.clearRect(0, 0, size, size);
      const P = paramsAt(t);
      const alpha = A * P.fade;
      if (alpha <= 0.001) return;
      ctx.save();
      if (fold > 0) {
        const s2 = 1 - 0.4 * smooth(fold);
        ctx.translate(cx, cy);
        ctx.scale(s2, s2);
        ctx.translate(-cx, -cy);
      }

      const pulse = 1 + 0.1 * P.pulse * Math.sin(t * 0.0023 + style.phase);
      const rad = R * pulse;
      const domeH = domeFrac * rad;
      const domeZ = (/** @type {number} */ r) =>
        domeH * ((1 - pg) * (1 - r * r) + pg * (1 - r) * (1 - r));

      const swayAmp = 0.1 * P.camP;
      const rx = swayAmp * Math.sin(t * 0.0011 + style.phase);
      const ry = 0.8 * swayAmp * Math.cos(t * 0.0009 + style.phase * 1.4);
      // Dangle: sink slowly once the camera has dropped.
      const sink = t > T.tiltStart ? ((t - T.tiltStart) / 1000) * 0.02 * rad : 0;
      const f = {
        cosRX: Math.cos(rx),
        sinRX: Math.sin(rx),
        cosRY: Math.cos(ry),
        sinRY: Math.sin(ry),
        zOff: -sink,
        cam: P.cam,
      };

      /** @param {number} rFrac @param {number} theta @param {number} [edgeF] */
      const pt = (rFrac, theta, edgeF) => {
        const a = theta + twistOffset(rFrac, P.twist) + spin;
        const r = rFrac * rad * (edgeF ?? 1);
        return toScreen({ x: r * Math.cos(a), y: r * Math.sin(a), z: domeZ(rFrac) }, f);
      };

      const panelA = (2 * Math.PI) / PANELS;

      // -- gore fill: flag colors while twirling, pink/white once revived ----
      /** @param {number} a @param {(i:number)=>string} colorOf */
      const fillPanels = (a, colorOf) => {
        ctx.globalAlpha = a;
        for (let i = 0; i < PANELS; i++) {
          const a0 = i * panelA;
          const a1 = a0 + panelA;
          ctx.beginPath();
          const c = pt(0, a0);
          ctx.moveTo(c.x, c.y);
          for (let k = 1; k <= 6; k++) ctx.lineTo(pt(k / 6, a0).x, pt(k / 6, a0).y);
          for (let k = 0; k <= 8; k++) {
            const fr = k / 8;
            const p = pt(1, a0 + fr * panelA, scallopFactor(fr, P.scallop, sc));
            ctx.lineTo(p.x, p.y);
          }
          for (let k = 6; k >= 0; k--) ctx.lineTo(pt(k / 6, a1).x, pt(k / 6, a1).y);
          ctx.closePath();
          ctx.fillStyle = colorOf(i);
          ctx.fill();
        }
      };

      if (P.fill > 0.01) fillPanels(P.fill * alpha, (i) => (i % 2 ? BLUE : YELLOW));
      if (P.revive > 0.01) {
        const rv = smooth(P.revive) * alpha;
        fillPanels(rv, (i) => (i % 2 ? style.alt : style.col));
        // The thick contrasting rim band, rFrac 0.72 → scalloped edge.
        const seg = PANELS * 12;
        ctx.globalAlpha = rv;
        ctx.fillStyle = style.border;
        ctx.beginPath();
        for (let k = 0; k <= seg; k++) {
          const ang = (k / seg) * 2 * Math.PI;
          const fr = (ang / panelA) % 1;
          const p = pt(1, ang, scallopFactor(fr, P.scallop, sc));
          if (k === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        }
        for (let k = seg; k >= 0; k--) {
          const p = pt(0.72, (k / seg) * 2 * Math.PI);
          ctx.lineTo(p.x, p.y);
        }
        ctx.closePath();
        ctx.fill();
      }

      // -- the wire drawing (contours) — gilds as the canopy comes alive -----
      if (P.wire > 0) {
        const ribP = clamp01(P.wire / 0.45);
        const ringP = clamp01((P.wire - 0.25) / 0.45);
        const edgeP = clamp01((P.wire - 0.5) / 0.5);
        const gild = smooth(P.revive);
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = lerpCol(INK, style.border, gild);
        ctx.lineWidth = Math.max(0.8, rad * (0.02 + 0.01 * gild));
        ctx.lineCap = "round";
        ctx.lineJoin = "round";

        if (ribP > 0) {
          for (let i = 0; i < PANELS; i++) {
            const a0 = i * panelA;
            const steps = Math.ceil(10 * ribP);
            ctx.beginPath();
            const c = pt(0, a0);
            ctx.moveTo(c.x, c.y);
            for (let k = 1; k <= steps; k++) {
              const p = pt(Math.min(k / 10, ribP), a0);
              ctx.lineTo(p.x, p.y);
            }
            ctx.stroke();
          }
        }
        for (const ringR of [0.42, 0.72]) {
          if (ringP <= 0) break;
          const total = 44;
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
          const perPanel = 8;
          const total = PANELS * perPanel;
          const steps = Math.ceil(total * edgeP);
          ctx.beginPath();
          const p0 = pt(1, 0, scallopFactor(0, P.scallop, sc));
          ctx.moveTo(p0.x, p0.y);
          for (let k = 1; k <= steps; k++) {
            const panel = Math.floor((k - 1) / perPanel);
            const fr = (k - panel * perPanel) / perPanel;
            const p = pt(1, (panel + fr) * panelA, scallopFactor(fr, P.scallop, sc));
            ctx.lineTo(p.x, p.y);
          }
          ctx.stroke();
        }

        // -- shaft + crook handle: the third dimension, once the camera tilts -
        if (P.shaft > 0) {
          ctx.globalAlpha = alpha * P.shaft;
          ctx.strokeStyle = lerpCol(INK, HANDLE, gild);
          ctx.lineWidth = Math.max(0.9, rad * (0.03 + 0.01 * gild));
          const axis = (/** @type {number} */ z) => toScreen({ x: 0, y: 0, z }, f);
          const apex = axis(domeH);
          const bottom = axis(-0.9 * rad);
          ctx.beginPath();
          ctx.moveTo(apex.x, apex.y);
          ctx.lineTo(bottom.x, bottom.y);
          ctx.stroke();
          // The J-crook, carried around by the spin.
          const hr = 0.12 * rad;
          ctx.beginPath();
          let first = true;
          for (let k = 0; k <= 12; k++) {
            const a = Math.PI + (k / 12) * (Math.PI + 0.6);
            const hx = hr + hr * Math.cos(a);
            const hz = -0.9 * rad + hr * Math.sin(a);
            const p = toScreen({ x: hx * Math.cos(spin), y: hx * Math.sin(spin), z: hz }, f);
            if (first) {
              ctx.moveTo(p.x, p.y);
              first = false;
            } else ctx.lineTo(p.x, p.y);
          }
          ctx.stroke();
        }

        // -- dangling beaded fringe: unspools last, only in the tilted view ---
        if (P.deco > 0 && P.shaft > 0.15) {
          const strandsPerPanel = 3;
          const len = 0.18 * rad * P.deco;
          ctx.lineCap = "round";
          ctx.strokeStyle = style.border;
          ctx.lineWidth = Math.max(0.7, rad * 0.016);
          const tasselR = Math.max(0.9, rad * 0.03);
          ctx.globalAlpha = alpha * P.deco;
          for (let i = 0; i < PANELS; i++) {
            for (let j = 0; j < strandsPerPanel; j++) {
              const fr = (j + 0.5) / strandsPerPanel;
              const a = (i + fr) * panelA + spin;
              const rr = rad * scallopFactor(fr, P.scallop, sc);
              const bx = rr * Math.cos(a);
              const by = rr * Math.sin(a);
              const swing = 0.4 * Math.sin(t * 0.004 + a * 2.6 + style.phase);
              const tx = -Math.sin(a);
              const ty = Math.cos(a);
              const rim = toScreen({ x: bx, y: by, z: 0 }, f);
              const mid = toScreen(
                { x: bx + swing * len * 0.5 * tx, y: by + swing * len * 0.5 * ty, z: -len * 0.5 },
                f
              );
              const tip = toScreen(
                { x: bx + swing * len * tx, y: by + swing * len * ty, z: -len },
                f
              );
              ctx.beginPath();
              ctx.moveTo(rim.x, rim.y);
              ctx.quadraticCurveTo(mid.x, mid.y, tip.x, tip.y);
              ctx.stroke();
              ctx.fillStyle = CREAM;
              ctx.beginPath();
              ctx.arc(tip.x, tip.y, tasselR, 0, 2 * Math.PI);
              ctx.fill();
            }
          }
        }
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    }

    /** The pink ✓ the umbrella folds into. `prog` (0..1) draws it on; `a` its
     * opacity. A fixed rose (matching the CSS `.check`) so the canvas ✓ hands
     * off seamlessly to the real checkmark the caller swaps in.
     * @param {number} prog @param {number} a */
    function drawCheck(prog, a) {
      if (!ctx || a <= 0.001) return;
      const h = R * 1.05;
      const ccx = cx;
      const ccy = cy + R * 0.12; // sit where the CSS ✓ lands
      const P1 = { x: ccx - 0.46 * h, y: ccy + 0.04 * h };
      const P2 = { x: ccx - 0.08 * h, y: ccy + 0.4 * h };
      const P3 = { x: ccx + 0.52 * h, y: ccy - 0.44 * h };
      const seg = (
        /** @type {{x:number,y:number}} */ p,
        /** @type {{x:number,y:number}} */ q
      ) => Math.hypot(q.x - p.x, q.y - p.y);
      const L1 = seg(P1, P2);
      const L2 = seg(P2, P3);
      const d = clamp01(prog) * (L1 + L2);
      const sc2 = 0.7 + 0.3 * smooth(clamp01(prog)); // scales up as it draws on
      ctx.save();
      ctx.translate(ccx, ccy);
      ctx.scale(sc2, sc2);
      ctx.translate(-ccx, -ccy);
      ctx.globalAlpha = a;
      ctx.strokeStyle = CHECK_PINK;
      ctx.lineWidth = Math.max(2, R * 0.16);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(P1.x, P1.y);
      if (d <= L1) {
        const u = L1 > 0 ? d / L1 : 1;
        ctx.lineTo(P1.x + (P2.x - P1.x) * u, P1.y + (P2.y - P1.y) * u);
      } else {
        ctx.lineTo(P2.x, P2.y);
        const u = L2 > 0 ? (d - L1) / L2 : 1;
        ctx.lineTo(P2.x + (P3.x - P2.x) * u, P2.y + (P3.y - P2.y) * u);
      }
      ctx.stroke();
      ctx.restore();
      ctx.globalAlpha = 1;
    }

    /** @param {number} now */
    function frame(now) {
      if (stopped || !ctx) return;
      // Self-terminate once the caller removed the host from the document —
      // the existing spinner-removal is the only cleanup callers do.
      if (!canvas.isConnected) return stop();
      if (!start) {
        start = now;
        lastT = 0;
      }

      // Design-time t and master alpha for this frame, per mode.
      let t;
      let master;
      let fold = 0; // umbrella→✓ collapse (finale fold phase only)
      let checkProg = 0; // ✓ draw-on progress (finale fold phase only)
      if (mode === "finale" && plan) {
        if (!finaleStart) finaleStart = now;
        const fe = now - finaleStart;
        if (fe < plan.runMs) {
          // Speed-run: fast-forward from the caught wave position, THROUGH the
          // pink revive the loop never reaches, up to the full pink umbrella.
          t = plan.runStart + (plan.runEnd - plan.runStart) * smooth(fe / plan.runMs);
          master = 1;
        } else if (fe < plan.runMs + plan.holdMs) {
          t = plan.runEnd; // live a beat, fully bloomed and pink
          master = 1;
        } else {
          t = plan.runEnd; // fold the pink umbrella into the ✓
          master = 1;
          checkProg = clamp01((fe - plan.runMs - plan.holdMs) / plan.checkMs);
          fold = checkProg;
        }
      } else {
        t = boomerangDesignTime(now - start, clockRate);
        // One-time fade-in over the first ~250 ms so the mount doesn't pop; after
        // that the umbrella stays fully visible and just morphs vortex↔wobble.
        master = smooth((now - start) / 250);
      }

      // Signed design-time delta drives the separately-integrated spin: POSITIVE
      // on the forward sweep / speed-run, NEGATIVE on the boomerang rewind, so
      // the rotation reverses with the timeline. Clamped so a backgrounded tab's
      // time jump (or the triangle-wave apex) can't fling the angle.
      let dtd = t - lastT;
      lastT = t;
      const cap = 60 * clockRate;
      if (dtd > cap) dtd = cap;
      else if (dtd < -cap) dtd = -cap;
      spin += style.dir * (style.speed || 1) * paramsAt(t).spinRate * 0.0016 * dtd;

      // The umbrella fades out as the ✓ draws in during the fold.
      drawUmbrella(t, master * (1 - smooth(checkProg)), fold);
      if (checkProg > 0) drawCheck(checkProg, smooth(checkProg));

      if (mode === "finale" && checkProg >= 1 && !doneCalled) {
        // The ✓ is fully formed: leave it on the canvas and hand off to the
        // caller (which swaps in its real .check span), so there's no gap. Stop
        // the RAF; the caller's removal of the host tears down the canvas.
        doneCalled = true;
        const cb = onFinaleDone;
        onFinaleDone = null;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        if (cb) cb();
        return;
      }
      raf = requestAnimationFrame(frame);
    }

    raf = requestAnimationFrame(frame);
    return { stop, finish };
  } catch {
    // Decoration must never cost a chat — fall back to the CSS spinner.
    return noop;
  }
}
