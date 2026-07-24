// @ts-check
// The plant SPINNER: SDK mode's waiting symbol — the third member of the
// spinner family after Se/cure's umbrella (umbrella-spinner.js, pink ✓) and
// Se/rver's balloon (balloon-spinner.js, blue ✓). SDK mode ("the lovable
// distiller" — chat-mode.js, the green pane) grows a new flavour of the site,
// so its symbol GROWS a plant. The loop matches the composer chip's 🌱
// (owner directive, 2026-07-24: NO BROWN — no seed dropping in, no soil
// mound; the earlier life-cycle's brown beats read as dirt): a sprout simply
// APPEARS and grows up to the emoji's own shape — a stem with two green
// leaves — sways there a beat, fades, and grows again, time and time again.
// Completion is the payoff the loop was climbing toward: the finale
// FAST-FORWARDS the sprout into an actual open flower, the flower SCATTERS a
// handful of tiny golden seeds that fall all over, and the plant folds into
// the GREEN ✓.
//
// It keeps the umbrella family's finale pacing (FINALE_* from
// umbrella-spinner.js) so the three symbols stay siblings by construction;
// the plant's own loop clock, growth timeline, seed scatter, geometry and the
// green ✓ live here. Split the family way: the pure helpers below
// (plantStateAt, cycleDesignTime, cycleStateAt, planPlantFinale,
// scatterSeedAt, spinnerStyle, plantPhaseAt) run in Node for the unit suite
// (plant-spinner.test.js); mountPlantSpinner only ever runs in a browser.
//
// Same contract as mountBalloonSpinner / mountUmbrellaSpinner: best-effort
// mount returning {stop, finish}, entirely fail-soft — a no-op mount still
// fires finish()'s callback so the caller always gets its checkmark.

import {
  FINALE_CHECK_MS,
  FINALE_HOLD_MS,
  FINALE_RUN_MS,
  canCanvas,
  reducedMotion,
} from "./umbrella-spinner.js";

// ---- pure helpers (Node-tested) ----------------------------------------------------

// The plant's clock is set at its own felt pace (design-ms per real-ms). One
// sprout generation (grow + sway + fade) lands around a second and a half.
export const BASE_SPEED = 1.6;

/** Clamp any admin animation multiplier to a sane band (mirrors the family's
 * clampAnimMult; kept local so the plant doesn't couple to umbrella/balloon
 * geometry modules).
 * @param {unknown} v @returns {number} */
export function clampAnimMult(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(4, Math.max(0.25, n));
}

/** Clamp to [0,1], NaN → 0. @param {unknown} x @returns {number} */
export function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Smoothstep on [0,1]. @param {number} x @returns {number} */
export function smooth(x) {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}

/** Fraction of a segment [a,b] covered by t, clamped to [0,1]. Total.
 * @param {number} t @param {number} a @param {number} b @returns {number} */
function seg(t, a, b) {
  return b > a ? clamp01((t - a) / (b - a)) : t >= b ? 1 : 0;
}

// The growth timeline (design-ms). One monotonic ladder serves both the loop
// and the finale; the loop only ever climbs to SPROUT_APEX (the 🌱 shape),
// the finale alone runs the ladder out to the flower:
//   [0 .. SPROUT_APEX)      the sprout appears and grows — stem up, the two
//                           leaves unfurl into the emoji's own silhouette
//   [SPROUT_APEX .. FULL)   (finale fast-forward) stem shoots up, true
//                           leaves, and the gold bloom opens at the tip
export const SPROUT_APEX = 1400;
/** The fully grown, open flower — the growth ladder's top (finale only). */
export const FULL_APEX = 2700;
/** How long the loop sways at the 🌱 shape before fading to regrow. */
export const SPROUT_HOLD_MS = 620;
/** The fade-out beat between generations — no pop, just a soft handoff. */
export const SPROUT_FADE_MS = 420;
/** One full generation of the loop: grow, sway, fade, regrow. */
export const CYCLE_END = SPROUT_APEX + SPROUT_HOLD_MS + SPROUT_FADE_MS;

/** How far up the full stem the sprout stage reaches (the 🌱 proportion). */
export const SPROUT_STEM = 0.5;

/** Which named beat of the growth ladder design-time t lands in.
 * @param {number} t @returns {"sprout"|"grow"|"bloom"} */
export function plantPhaseAt(t) {
  const tt = Number.isFinite(t) ? Math.max(0, t) : 0;
  if (tt < SPROUT_APEX) return "sprout";
  return tt >= SPROUT_APEX + (FULL_APEX - SPROUT_APEX) * 0.5 ? "bloom" : "grow";
}

/**
 * The plant's geometry at design-time t — pure, deterministic, total. All
 * fields are normalized fractions the DOM layer scales into pixels. Monotonic
 * (stemH, leafOpen, trueLeaf, bloom never decrease as t advances), so the
 * finale interpolation only ever GROWS.
 * @param {number} t design-ms in [0, FULL_APEX]
 * @returns {{stemH:number, leafOpen:number, trueLeaf:number, bloom:number}}
 */
export function plantStateAt(t) {
  const tt = Number.isFinite(t) ? Math.min(Math.max(0, t), FULL_APEX) : 0;
  const sprout = smooth(seg(tt, 0, SPROUT_APEX));
  const grow = smooth(seg(tt, SPROUT_APEX, FULL_APEX));
  // Stem: the sprout stage rises to SPROUT_STEM; the finale carries it the
  // rest of the way to full height. Continuous at the apex.
  const stemH = SPROUT_STEM * sprout + (1 - SPROUT_STEM) * grow;
  // The two emoji leaves unfurl while the stem rises, fully open at the apex.
  const leafOpen = smooth(seg(tt, SPROUT_APEX * 0.3, SPROUT_APEX));
  const trueLeaf = grow; // the true leaf pair only unfurls while growing out
  // The bloom opens in the last stretch of the grow beat.
  const bloom = smooth(seg(tt, SPROUT_APEX + (FULL_APEX - SPROUT_APEX) * 0.5, FULL_APEX));
  return { stemH, leafOpen, trueLeaf, bloom };
}

// ---- the loop (the sprout's clock) -------------------------------------------------

/**
 * The loop's clock: elapsed design-ms → cycle-time in [0, CYCLE_END). Every
 * generation is the same story — the sprout grows in from nothing, sways,
 * fades — so the clock is a plain wrap. Pure and total.
 * @param {number} elapsedDesign design-ms since mount
 * @returns {number} cycle-time in [0, CYCLE_END)
 */
export function cycleDesignTime(elapsedDesign) {
  const e = Number.isFinite(elapsedDesign) ? Math.max(0, elapsedDesign) : 0;
  return e % CYCLE_END;
}

/**
 * The loop overlay at cycle-time ct — the growth design-time to render and
 * how far the between-generations fade has run. The fade reaches 1 exactly at
 * the wrap, so the vanished sprout hands off to the next generation growing
 * in from nothing (no pop). Total.
 * @param {number} ct cycle-time
 * @returns {{t:number, fade:number}}
 */
export function cycleStateAt(ct) {
  const c = Number.isFinite(ct) ? Math.max(0, Math.min(ct, CYCLE_END)) : 0;
  const t = Math.min(c, SPROUT_APEX);
  const fade = smooth(seg(c, SPROUT_APEX + SPROUT_HOLD_MS, CYCLE_END));
  return { t, fade };
}

// Finale bucketing: how deep into the loop a completion was caught decides how
// long the grow-out runs (deeper along → a shorter runway, the family rule).
const PLANT_FINALE_MARKS = [
  SPROUT_APEX * 0.25,
  SPROUT_APEX * 0.5,
  SPROUT_APEX * 0.75,
  SPROUT_APEX - 1,
];

/** Which speed-run bucket a completion caught at design-time t0 uses.
 * @param {number} t0 @returns {number} 0..4 */
export function plantFinaleBucket(t0) {
  const t = Number.isFinite(t0) ? Math.max(0, t0) : 0;
  let b = 0;
  for (const m of PLANT_FINALE_MARKS) if (t >= m) b++;
  return b;
}

/** The finale plan for a completion caught at design-time t0 — the
 * fast-forward to the open flower, the seed-scatter beat holding it, the fold
 * into the ✓. Pure and deterministic; the browser just plays it out. Shares
 * the family's runway/hold/check pacing (FINALE_* from umbrella-spinner.js).
 * @param {number} t0
 * @returns {{bucket:number, runStart:number, runEnd:number, runMs:number,
 *            holdMs:number, checkMs:number, totalMs:number}} */
export function planPlantFinale(t0) {
  const start = Number.isFinite(t0) ? Math.min(Math.max(0, t0), FULL_APEX) : 0;
  const bucket = plantFinaleBucket(start);
  const runMs = FINALE_RUN_MS[bucket];
  return {
    bucket,
    runStart: start,
    runEnd: FULL_APEX,
    runMs,
    holdMs: FINALE_HOLD_MS,
    checkMs: FINALE_CHECK_MS,
    totalMs: runMs + FINALE_HOLD_MS + FINALE_CHECK_MS,
  };
}

// ---- the completion seed scatter (pure) --------------------------------------------

/** How many tiny seeds the finale's flower lets fall. */
export const SCATTER_SEEDS = 8;

/**
 * One scattered seed's normalized position at scatter progress p (0..1):
 * where the i-th seed is on its way down from the flower. `x` is a horizontal
 * offset in [-1,1] (the DOM layer scales it to the fall's spread), `y` the
 * fallen fraction (0 at the flower, 1 on the ground, gravity-eased), `a` the
 * seed's alpha (0 before its staggered release, fading out as it lands so the
 * ✓ ends clean). Deterministic — the stagger and drift come from the index,
 * not a RNG — pure and total.
 * @param {number} i seed index
 * @param {number} p scatter progress 0..1
 * @returns {{x:number, y:number, a:number}}
 */
export function scatterSeedAt(i, p) {
  const idx = Number.isFinite(i) ? Math.abs(Math.trunc(i)) : 0;
  // Golden-ratio hashing: an even, non-repeating spread without randomness.
  const u = (idx * 0.6180339887 + 0.19) % 1;
  const delay = 0.55 * ((idx * 0.3819660113 + 0.07) % 1);
  const local = clamp01((clamp01(p) - delay) / (1 - delay));
  const x = (u * 2 - 1) * local; // drifts outward as it falls
  const y = local * local; // gravity-eased fall
  const a = local <= 0 ? 0 : 1 - smooth(seg(local, 0.82, 1));
  return { x, y, a };
}

/** @typedef {{ leaf:string, stem:string, seed:string, flower:string,
 *              center:string, dir:number, speed:number }} PlantStyle */

/** The plant fleet: a few green-and-gold schemes (SDK's palette), cycled so
 * adjacent loading slots differ — the same "same shape, varied color" rule the
 * balloon fleet follows. The scattered seeds are GOLDEN, never brown (owner
 * directive, 2026-07-24). @type {PlantStyle[]} */
export const PLANT_FLEET = [
  { leaf: "#3fae63", stem: "#2f8f4e", seed: "#e6c245", flower: "#f5c518", center: "#e8a713", dir: 1, speed: 1 },
  { leaf: "#5cc07d", stem: "#3a9a58", seed: "#f0d067", flower: "#ffd54a", center: "#f0b31e", dir: -1, speed: 1.08 },
  { leaf: "#2f9d57", stem: "#277f45", seed: "#dbb838", flower: "#f7cf3f", center: "#e6a50f", dir: 1, speed: 0.94 },
];

/** The style for the i-th loading slot (defensive on the index).
 * @param {number} index @returns {PlantStyle} */
export function spinnerStyle(index) {
  const n = PLANT_FLEET.length;
  const i = Number.isFinite(index) ? ((Math.trunc(index) % n) + n) % n : 0;
  return PLANT_FLEET[i];
}

// ---- the shared plant renderer (browser only, but geometry-driven) -----------------
// One renderer draws the plant for BOTH the spinner and the greeter
// (sdk-plant.js), so SDK's waiting symbol and its character stay the same plant
// by construction — the family rule (balloon/umbrella share one figure drawer).

/** @typedef {{ cx:number, groundY:number, maxStem:number, size:number,
 *              style:PlantStyle }} PlantGeo */

/** A leaf blade as a rounded lens from (0,0) along +x, length L, width W.
 * @param {CanvasRenderingContext2D} ctx @param {number} L @param {number} W */
function leafPath(ctx, L, W) {
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(L * 0.5, -W, L, 0);
  ctx.quadraticCurveTo(L * 0.5, W, 0, 0);
  ctx.closePath();
}

/**
 * Draw the plant figure at state S into ctx using the geometry box. Total: a
 * near-zero alpha or an empty state is a no-op. Shared by mountPlantSpinner and
 * the greeter. Green and gold only — nothing brown is ever drawn.
 * @param {CanvasRenderingContext2D} ctx
 * @param {PlantGeo} geo
 * @param {ReturnType<typeof plantStateAt>} S
 * @param {number} sway stem bend (radians)
 * @param {number} a alpha
 */
export function drawPlantFigure(ctx, geo, S, sway, a) {
  if (!ctx || a <= 0.002) return;
  const { cx, groundY, maxStem, size, style } = geo;
  ctx.save();
  ctx.globalAlpha = a;

  // The stem, growing from the base line upward with a gentle sway bend.
  const h = maxStem * S.stemH;
  if (h > 1) {
    const tipX = cx + Math.sin(sway) * h * 0.28;
    const tipY = groundY - h;
    const midX = cx + Math.sin(sway) * h * 0.11;
    const midY = groundY - h * 0.5;
    ctx.strokeStyle = style.stem;
    ctx.lineWidth = Math.max(2, size * 0.028);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(cx, groundY);
    ctx.quadraticCurveTo(midX, midY, tipX, tipY);
    ctx.stroke();

    // The emoji pair: two leaves in an upward V at the sprout's tip — the 🌱
    // silhouette the loop grows into. Once the finale stem outgrows the
    // sprout stage they stay put as the lower pair (a real plant's history).
    if (S.leafOpen > 0.02) {
      const sproutH = Math.min(h, maxStem * SPROUT_STEM);
      const ly = groundY - sproutH * 0.92;
      const lx = cx + Math.sin(sway) * sproutH * 0.24;
      const L = size * 0.15 * S.leafOpen;
      const W = size * 0.065 * S.leafOpen;
      ctx.fillStyle = style.leaf;
      for (const dir of [-1, 1]) {
        // Slightly unequal leaves, like the emoji's.
        const k = dir < 0 ? 0.82 : 1;
        ctx.save();
        ctx.translate(lx, ly);
        ctx.rotate(dir * -(0.45 + 0.25 * S.leafOpen) + sway * 0.5);
        ctx.scale(dir, 1);
        leafPath(ctx, L * k, W * k);
        ctx.fill();
        ctx.restore();
      }
    }

    // True leaves: a larger pair mid-stem that unfurl during the fast-forward.
    if (S.trueLeaf > 0.02) {
      const ly = groundY - h * 0.7;
      const lx = tipX * 0.5 + cx * 0.5;
      const L = size * 0.16 * S.trueLeaf;
      const W = size * 0.075 * S.trueLeaf;
      ctx.fillStyle = style.leaf;
      for (const dir of [-1, 1]) {
        ctx.save();
        ctx.translate(lx, ly);
        ctx.rotate(dir * -(0.35 + 0.25 * S.trueLeaf) + sway * 0.4);
        ctx.scale(dir, 1);
        leafPath(ctx, L, W);
        ctx.fill();
        ctx.restore();
      }
    }

    // The bloom: the actual flower that opens at the tip in the last beat.
    if (S.bloom > 0.02) {
      const petals = 6;
      const pr = size * 0.056 * S.bloom;
      const spread = size * 0.052 * smooth(S.bloom);
      ctx.save();
      ctx.translate(tipX, tipY);
      ctx.fillStyle = style.flower;
      for (let i = 0; i < petals; i++) {
        const ang = (i / petals) * Math.PI * 2 + sway;
        ctx.save();
        ctx.rotate(ang);
        ctx.beginPath();
        ctx.ellipse(spread, 0, pr, pr * 0.6, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      ctx.fillStyle = style.center;
      ctx.beginPath();
      ctx.arc(0, 0, pr * 0.85, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  ctx.restore();
  ctx.globalAlpha = 1;
}

// ---- the DOM layer (browser only) --------------------------------------------------

const CHECK_GREEN = "#1f8a4c"; // the finale's ✓ — matches app.css --check-green,
// so the canvas ✓ hands off seamlessly to the real .check span the caller swaps
// in. The plant is SDK mode's own symbol (docs/SYMBOL-LANGUAGE.md §7).

// canCanvas / reducedMotion come from the umbrella sibling (imported above).

/**
 * Replace a small loading slot with the looping sprout animation — the exact
 * contract of mountBalloonSpinner / mountUmbrellaSpinner (mode-spinner.js swaps
 * the factory by mode and changes nothing else): best-effort mount that leaves
 * the CSS spinner untouched on reduced-motion/no-canvas, a canvas centered over
 * the host and allowed to overflow, self-terminating once the host leaves the
 * document.
 *
 * @param {HTMLElement} host  the `.spin` / `.typing-icon` element
 * @param {{ size?: number, style?: number, speed?: number }} [opts]
 * @returns {{ stop: () => void, finish: (onDone?: () => void) => void }}
 *   stop   — tear down immediately (no finale), for cancel/settle paths.
 *   finish — fast-forward to the flower, scatter its seeds, fold into the
 *            green ✓, then call onDone ONCE; a no-op mount fires onDone
 *            immediately.
 */
export function mountPlantSpinner(host, opts = {}) {
  const noop = {
    stop: () => {},
    /** @param {(() => void)=} onDone */
    finish: (onDone) => {
      if (typeof onDone === "function") onDone();
    },
  };
  try {
    if (!host || !canCanvas() || reducedMotion()) return noop;

    const hostBox = host.getBoundingClientRect();
    const base = Math.max(hostBox.width, hostBox.height) || 32;
    const size = Math.round(opts.size || base * 2.4);
    const style = spinnerStyle(opts.style ?? 0);
    const clockRate = BASE_SPEED * clampAnimMult(opts.speed);

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

    const cx = size / 2;
    const groundY = size * 0.78; // the base line the sprout grows from
    const maxStem = size * 0.52; // full-grown stem height
    const seedR = size * 0.028; // the scattered seeds are TINY
    /** @type {PlantGeo} */
    const geo = { cx, groundY, maxStem, size, style };

    let raf = 0;
    let startMs = 0;
    let lastT = 0;
    let lastFlip = 0;
    let lastFade = 0; // the loop's current between-generations fade
    let fadeAtFinale = 0;
    let stopped = false;

    let mode = /** @type {"loop"|"finale"} */ ("loop");
    let finaleStart = 0;
    let plan = /** @type {ReturnType<typeof planPlantFinale>|null} */ (null);
    let onFinaleDone = /** @type {(() => void)|null} */ (null);
    let doneCalled = false;

    function stop() {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      canvas.remove();
    }

    /** Begin the completion finale from wherever the sprout is right now.
     * Idempotent; a stopped spinner fires onDone at once.
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
      // A sprout caught mid-fade revives at the finale's start (the
      // fast-forward needs a whole plant to grow).
      fadeAtFinale = lastFade;
      plan = planPlantFinale(lastT);
      finaleStart = 0;
      mode = "finale";
    }

    /** The green ✓ the plant folds into — same geometry as the balloon/umbrella
     * spinner's ✓, in SDK green so it hands off to the CSS .check.
     * @param {number} prog @param {number} a */
    function drawCheck(prog, a) {
      if (!ctx || a <= 0.001) return;
      const R = size * 0.26;
      const h = R * 1.05;
      const ccx = cx;
      const ccy = groundY - maxStem * 0.5; // where the grown plant's body sat
      const P1 = { x: ccx - 0.46 * h, y: ccy + 0.04 * h };
      const P2 = { x: ccx - 0.08 * h, y: ccy + 0.4 * h };
      const P3 = { x: ccx + 0.52 * h, y: ccy - 0.44 * h };
      const L1 = Math.hypot(P2.x - P1.x, P2.y - P1.y);
      const L2 = Math.hypot(P3.x - P2.x, P3.y - P2.y);
      const d = clamp01(prog) * (L1 + L2);
      const sc2 = 0.7 + 0.3 * smooth(clamp01(prog));
      ctx.save();
      ctx.translate(ccx, ccy);
      ctx.scale(sc2, sc2);
      ctx.translate(-ccx, -ccy);
      ctx.globalAlpha = a;
      ctx.strokeStyle = CHECK_GREEN;
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
      if (!canvas.isConnected) return stop();
      if (!startMs) startMs = now;

      let t;
      let master;
      let fold = 0;
      let checkProg = 0;
      let sway = 0;
      let fadeOut = 0;
      let scatter = -1; // ≥0 only while the finale's seeds are falling
      if (mode === "finale" && plan) {
        if (!finaleStart) finaleStart = now;
        const fe = now - finaleStart;
        // Revive a mid-fade sprout over the finale's opening beats.
        fadeOut = fadeAtFinale * (1 - smooth(clamp01(fe / 320)));
        if (fe < plan.runMs) {
          t = plan.runStart + (plan.runEnd - plan.runStart) * smooth(fe / plan.runMs);
          master = 1;
          sway = lastFlip * 0.4 * (1 - smooth(fe / plan.runMs));
        } else {
          t = plan.runEnd;
          master = 1;
          // The flower's seeds fall through the hold AND the ✓ stroke-in —
          // tiny golden seeds scattering all over as the work completes.
          scatter = clamp01((fe - plan.runMs) / (plan.holdMs + plan.checkMs));
          if (fe >= plan.runMs + plan.holdMs) {
            checkProg = clamp01((fe - plan.runMs - plan.holdMs) / plan.checkMs);
            fold = checkProg;
          }
        }
      } else {
        const cyc = cycleStateAt(cycleDesignTime((now - startMs) * clockRate));
        t = cyc.t;
        fadeOut = cyc.fade;
        // A gentle sway that deepens as the sprout reaches its shape.
        sway = Math.sin((now - startMs) / 620) * (0.05 + 0.09 * (t / SPROUT_APEX));
        lastFlip = sway;
        lastFade = fadeOut;
        master = smooth((now - startMs) / 260);
      }
      lastT = t;

      ctx.clearRect(0, 0, size, size);
      const S = plantStateAt(t);
      const aBase = master * (1 - smooth(checkProg));
      const a = aBase * (1 - fadeOut);
      if (a > 0.002) {
        ctx.save();
        if (fold > 0) {
          // Fold: the flower shrinks toward the ✓ as the check strokes in.
          const s2 = 1 - 0.4 * smooth(fold);
          const fy = groundY - maxStem * 0.5;
          ctx.translate(cx, fy);
          ctx.scale(s2, s2);
          ctx.translate(-cx, -fy);
        }
        drawPlantFigure(ctx, geo, S, sway, a);
        ctx.restore();
      }
      if (checkProg > 0) drawCheck(checkProg, smooth(checkProg));
      if (scatter >= 0) {
        // The seed scatter: tiny golden seeds let go at the flower and fall
        // all over, drifting outward on the way down (scatterSeedAt is the
        // pure per-seed clock). Drawn last so they fall over the ✓ too.
        const tipX = cx + Math.sin(sway) * maxStem * 0.28;
        const dropTop = groundY - maxStem + seedR * 3;
        const spreadPx = size * 0.42;
        ctx.fillStyle = style.seed;
        for (let i = 0; i < SCATTER_SEEDS; i++) {
          const sd = scatterSeedAt(i, scatter);
          if (sd.a <= 0.002) continue;
          const sx2 = tipX + sd.x * spreadPx;
          const sy2 = dropTop + (groundY + seedR * 2 - dropTop) * sd.y;
          ctx.globalAlpha = sd.a * master;
          ctx.beginPath();
          ctx.ellipse(sx2, sy2, seedR * 1.15, seedR, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }

      if (mode === "finale" && checkProg >= 1 && !doneCalled) {
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
