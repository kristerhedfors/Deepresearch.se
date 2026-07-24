// @ts-check
// The plant SPINNER: SDK mode's waiting symbol — the third member of the
// spinner family after Se/cure's umbrella (umbrella-spinner.js, pink ✓) and
// Se/rver's balloon (balloon-spinner.js, blue ✓). SDK mode ("the lovable
// distiller" — chat-mode.js, the green pane) grows a new flavour of the site,
// so its symbol GROWS a plant — and unlike its boomerang siblings the loop
// runs FORWARD, as a generational LIFE-CYCLE (owner directive, 2026-07-23:
// the old boomerang rewound through the seed drop over and over and read as
// a brown bouncing ball; the seed→seedling→flower story is the animation;
// amended 2026-07-24: it is a SUNFLOWER in warm afternoon light — small
// black seeds, thin curly tendrils, golden petals round a dark seed head,
// a low-sun glow and long shadow, and far less brown): a handful of black
// seeds falls and GETS PLANTED, the plant sprouts, grows — stem, true
// leaves, curling tendrils — and BLOOMS right in the loop; the open head
// sways a beat, then RELEASES a fresh handful that falls to the soil while
// the parent withers away, and the fallen seeds replant as the next
// generation. The beat reserved for "done" is the ✓ itself: the completion
// finale catches the plant wherever it is, grows it out to full bloom,
// holds it, and folds it into a GREEN ✓.
//
// It keeps the umbrella family's finale pacing (FINALE_* from
// umbrella-spinner.js) so the three symbols stay siblings by construction;
// the plant's own forward cycle clock, growth timeline, geometry and the
// green ✓ live here. Split the family way: the pure helpers below
// (plantStateAt, cycleDesignTime, cycleStateAt, planPlantFinale,
// spinnerStyle, plantPhaseAt) run in Node for the unit suite
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

// The plant's clock is set at its own felt pace (design-ms per real-ms). The
// life-cycle loop tells a whole growth story per generation, so it runs
// slower than the boomerang siblings — one generation lands around 2.6 s.
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
// and the finale; past FULL_APEX the cycle beats (hold + release) carry the
// loop into its next generation:
//   [0 .. DROP_END)       the seed handful falls and settles (gravity-eased)
//   [DROP_END .. PLANT)   it GETS PLANTED, a small soil hint forms
//   [PLANT .. LOOP_APEX)  a short sprout with two cotyledon leaves
//   [LOOP_APEX .. FULL)   stem shoots up, true leaves + the gold-green bloom
//   [FULL .. +HOLD)       the open flower sways, held
//   [+HOLD .. CYCLE_END)  a new seed detaches and falls; the parent withers
// Later generations resume at REPLANT_AT — their seed has already fallen.
export const DROP_END = 520;
export const PLANT_END = 900;
/** End of the sprout beat (the old boomerang loop's apex; the name stays for
 * the family symmetry and the finale buckets). */
export const LOOP_APEX = 1700;
/** The fully grown, blooming plant — the growth ladder's top. */
export const FULL_APEX = 2700;
/** How long the open bloom is held, swaying, before the seed release. */
export const BLOOM_HOLD_MS = 720;
/** The release beat: a fresh seed detaches and falls; the parent withers. */
export const RELEASE_MS = 760;
/** One full generation of the forward loop. */
export const CYCLE_END = FULL_APEX + BLOOM_HOLD_MS + RELEASE_MS;
/** Where later generations resume: their seed already fell (as the release),
 * so the sky-fall beat plays only for the first generation. */
export const REPLANT_AT = DROP_END;

/** Which named beat of the cycle design-time t lands in.
 * @param {number} t @returns {"drop"|"plant"|"sprout"|"grow"|"bloom"|"release"} */
export function plantPhaseAt(t) {
  const tt = Number.isFinite(t) ? Math.max(0, t) : 0;
  if (tt < DROP_END) return "drop";
  if (tt < PLANT_END) return "plant";
  if (tt < LOOP_APEX) return "sprout";
  if (tt >= FULL_APEX + BLOOM_HOLD_MS) return "release";
  // The last stretch of the growth ladder is the open bloom (held past FULL).
  return tt >= LOOP_APEX + (FULL_APEX - LOOP_APEX) * 0.62 ? "bloom" : "grow";
}

/**
 * The plant's geometry at design-time t — pure, deterministic, total. All
 * fields are normalized fractions the DOM layer scales into pixels. Monotonic
 * where growth is (fall, plantDepth, stemH, leafOpen, trueLeaf, bloom never
 * decrease as t advances), so the finale interpolation only ever GROWS.
 * @param {number} t design-ms in [0, FULL_APEX]
 * @returns {{fall:number, plantDepth:number, stemH:number,
 *            leafOpen:number, trueLeaf:number, bloom:number}}
 */
export function plantStateAt(t) {
  const tt = Number.isFinite(t) ? Math.min(Math.max(0, t), FULL_APEX) : 0;
  const drop = seg(tt, 0, DROP_END);
  // gravity: accelerate into the ground (ease-in), then pinned at 1.
  const fall = tt >= DROP_END ? 1 : drop * drop;
  const plantDepth = smooth(seg(tt, DROP_END, PLANT_END));
  const sprout = smooth(seg(tt, PLANT_END, LOOP_APEX));
  const grow = smooth(seg(tt, LOOP_APEX, FULL_APEX));
  // Stem: a short sprout (up to ~0.24) through the loop; the finale carries it
  // the rest of the way to full height. Continuous at the apex (sprout=1→0.24).
  const stemH = grow > 0 ? 0.24 + 0.76 * grow : 0.24 * sprout;
  const leafOpen = sprout; // cotyledons open in the sprout beat, stay open
  const trueLeaf = grow; // the true leaf pair only unfurls while growing
  // The bloom opens in the last stretch of the grow beat.
  const bloom = smooth(seg(tt, LOOP_APEX + (FULL_APEX - LOOP_APEX) * 0.5, FULL_APEX));
  return { fall, plantDepth, stemH, leafOpen, trueLeaf, bloom };
}

// ---- the forward cycle (the loop's clock) ------------------------------------------

/**
 * The loop's forward clock: elapsed design-ms → cycle-time. The FIRST
 * generation plays the whole story from the sky-fall; every later generation
 * wraps into [REPLANT_AT, CYCLE_END) — its seed already fell during the
 * parent's release, so the settled handful at REPLANT_AT (= DROP_END) is
 * continuous with the released seeds touching down. Pure, total, and
 * monotonic within a generation.
 * @param {number} elapsedDesign design-ms since mount
 * @returns {number} cycle-time in [0, CYCLE_END)
 */
export function cycleDesignTime(elapsedDesign) {
  const e = Number.isFinite(elapsedDesign) ? Math.max(0, elapsedDesign) : 0;
  if (e < CYCLE_END) return e;
  return REPLANT_AT + ((e - CYCLE_END) % (CYCLE_END - REPLANT_AT));
}

/**
 * The cycle overlay at cycle-time ct — what the growth ladder alone can't
 * say: how far the RELEASED seed has fallen and how far the parent has
 * withered. Both run to 1 at the wrap, so the released seed hands off to the
 * next generation's landed seed and the old plant is gone the frame the new
 * one begins (no pop). Total; `t` is the growth design-time to render.
 * @param {number} ct cycle-time
 * @returns {{t:number, releasing:boolean, seedDrop:number, wither:number}}
 */
export function cycleStateAt(ct) {
  const c = Number.isFinite(ct) ? Math.max(0, Math.min(ct, CYCLE_END)) : 0;
  const releaseStart = FULL_APEX + BLOOM_HOLD_MS;
  const t = Math.min(c, FULL_APEX);
  if (c < releaseStart) return { t, releasing: false, seedDrop: 0, wither: 0 };
  const seedDrop = clamp01((c - releaseStart) / RELEASE_MS);
  // The seed lets go first; the parent starts fading once it is clearly away.
  const wither = smooth(seg(c, releaseStart + RELEASE_MS * 0.3, CYCLE_END));
  return { t, releasing: true, seedDrop, wither };
}

// Finale bucketing: how deep into the loop a completion was caught decides how
// long the grow-out runs (deeper along → a shorter runway, the family rule).
const PLANT_FINALE_MARKS = [DROP_END, PLANT_END, 1200, LOOP_APEX - 1];

/** Which speed-run bucket a completion caught at design-time t0 uses.
 * @param {number} t0 @returns {number} 0..4 */
export function plantFinaleBucket(t0) {
  const t = Number.isFinite(t0) ? Math.max(0, t0) : 0;
  let b = 0;
  for (const m of PLANT_FINALE_MARKS) if (t >= m) b++;
  return b;
}

/** The finale plan for a completion caught at design-time t0 — the grow-out to
 * full bloom, the beat to hold it, the fold into the ✓. Pure and
 * deterministic; the browser just plays it out. Shares the family's runway/
 * hold/check pacing (FINALE_* from umbrella-spinner.js).
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

/** @typedef {{ leaf:string, stem:string, tendril:string, seed:string,
 *              flower:string, petalDeep:string, center:string, glow:string,
 *              dir:number, speed:number }} PlantStyle */

/** The plant fleet — SUNFLOWER schemes in warm afternoon light (owner
 * directive, 2026-07-24: less brown, black seeds, golden petals): warm
 * greens, two golds per head for petal depth, a dark seed-head center,
 * near-black seeds, and the low-sun glow color. Cycled so adjacent loading
 * slots differ — the same "same shape, varied color" rule the balloon fleet
 * follows. @type {PlantStyle[]} */
export const PLANT_FLEET = [
  { leaf: "#4f9e45", stem: "#41823c", tendril: "#6db34f", seed: "#26201a", flower: "#f6b73c", petalDeep: "#e09a26", center: "#4c351f", glow: "#ffcb6e", dir: 1, speed: 1 },
  { leaf: "#5fae52", stem: "#4a8f42", tendril: "#7cbf5c", seed: "#2e2620", flower: "#ffc84a", petalDeep: "#eaa632", center: "#543b22", glow: "#ffd27f", dir: -1, speed: 1.08 },
  { leaf: "#468f3e", stem: "#3a7635", tendril: "#63a84a", seed: "#221c16", flower: "#f0a92e", petalDeep: "#d8921f", center: "#452f1b", glow: "#f9c264", dir: 1, speed: 0.94 },
];

/** The handful of seeds: per-seed [landing x offset (× size), fall delay]
 * pairs, shared by the planting drop AND the release beat so the released
 * handful lands exactly where the next generation's settled handful sits
 * (the wrap stays continuous). Deterministic — no randomness (resume rule). */
export const SEED_SCATTER = [
  [-0.11, 0.0],
  [-0.045, 0.1],
  [0.0, 0.04],
  [0.05, 0.14],
  [0.1, 0.07],
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

/** @typedef {{ cx:number, groundY:number, topY:number, maxStem:number,
 *              seedR:number, size:number, style:PlantStyle }} PlantGeo */

/** A leaf blade as a rounded lens from (0,0) along +x, length L, width W.
 * @param {CanvasRenderingContext2D} ctx @param {number} L @param {number} W */
function leafPath(ctx, L, W) {
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(L * 0.5, -W, L, 0);
  ctx.quadraticCurveTo(L * 0.5, W, 0, 0);
  ctx.closePath();
}

/** The ground: a small, muted soil hint (owner directive, 2026-07-24 — far
 * less brown than the old mound) plus the LONG SHADOW of a low afternoon sun
 * stretching to the right, lengthening as the plant grows.
 * @param {CanvasRenderingContext2D} ctx @param {PlantGeo} geo
 * @param {number} depth 0..1 @param {number} stemH 0..1 @param {number} a */
function drawSoil(ctx, geo, depth, stemH, a) {
  if (depth <= 0.001) return;
  const { cx, groundY, size } = geo;
  ctx.save();
  if (stemH > 0.05) {
    const len = size * (0.08 + 0.26 * stemH);
    ctx.globalAlpha = a * 0.16;
    ctx.fillStyle = "#5a4630";
    ctx.beginPath();
    ctx.ellipse(cx + len * 0.6, groundY + size * 0.012, len, size * 0.02, 0.05, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = a * 0.5;
  ctx.fillStyle = "#7a5c39";
  ctx.beginPath();
  ctx.ellipse(cx, groundY, size * (0.075 + 0.035 * depth), size * 0.026 * depth, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.globalAlpha = 1;
}

/**
 * Draw the plant figure at state S into ctx using the geometry box. Total: a
 * near-zero alpha or an empty state is a no-op. Shared by mountPlantSpinner and
 * the greeter.
 * @param {CanvasRenderingContext2D} ctx
 * @param {PlantGeo} geo
 * @param {ReturnType<typeof plantStateAt>} S
 * @param {number} sway stem bend (radians)
 * @param {number} a alpha
 */
export function drawPlantFigure(ctx, geo, S, sway, a) {
  if (!ctx || a <= 0.002) return;
  const { cx, groundY, topY, maxStem, seedR, size, style } = geo;
  ctx.save();
  ctx.globalAlpha = a;

  // Warm afternoon light: a soft golden radial glow behind the plant that
  // strengthens as it grows and blooms (owner directive, 2026-07-24).
  const warmth = 0.35 + 0.4 * S.stemH + 0.25 * S.bloom;
  const glowA = a * 0.15 * warmth;
  if (glowA > 0.01) {
    const gx = cx + size * 0.08;
    const gy = groundY - maxStem * (0.5 + 0.4 * S.stemH);
    const gr = size * 0.5;
    const grad = ctx.createRadialGradient(gx, gy, gr * 0.08, gx, gy, gr);
    grad.addColorStop(0, style.glow);
    grad.addColorStop(1, "rgba(255,203,110,0)");
    ctx.save();
    ctx.globalAlpha = glowA;
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(gx, gy, gr, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  drawSoil(ctx, geo, S.plantDepth, S.stemH, a);

  // The falling / resting HANDFUL of small black seeds (before and as they
  // plant) — sunflower seeds, not one big ball, and no impact smash (owner
  // directive, 2026-07-24). Each seed trails its neighbours a little and
  // drifts out to its own landing spot. Once the plant is well grown they
  // hide under the leaves.
  if (S.stemH < 0.35) {
    for (let i = 0; i < SEED_SCATTER.length; i++) {
      const [ox, delay] = SEED_SCATTER[i];
      const f = clamp01((S.fall - delay) / (1 - delay));
      const sy = topY + f * (groundY - topY);
      const sx = cx + ox * size * (0.35 + 0.65 * f);
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(i * 0.9 + f * 0.6);
      ctx.fillStyle = style.seed;
      ctx.beginPath();
      ctx.ellipse(0, 0, seedR * 0.62, seedR * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // The stem, from the soil upward with a gentle sway bend. Nothing grows
  // until the seed has planted (plantDepth > 0).
  const h = maxStem * S.stemH;
  if (h > 1 && S.plantDepth > 0.02) {
    const tipX = cx + Math.sin(sway) * h * 0.28;
    const tipY = groundY - h;
    const midX = cx + Math.sin(sway) * h * 0.11;
    const midY = groundY - h * 0.5;
    ctx.strokeStyle = style.stem;
    ctx.lineWidth = Math.max(2, size * 0.026);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(cx, groundY);
    ctx.quadraticCurveTo(midX, midY, tipX, tipY);
    ctx.stroke();

    // Cotyledons: a low pair that open with leafOpen.
    if (S.leafOpen > 0.02) {
      const ly = groundY - h * 0.42;
      const lx = cx + Math.sin(sway) * h * 0.09;
      const L = size * 0.10 * S.leafOpen;
      const W = size * 0.05 * S.leafOpen;
      ctx.fillStyle = style.leaf;
      for (const dir of [-1, 1]) {
        ctx.save();
        ctx.translate(lx, ly);
        ctx.rotate(dir * (0.5 - 0.2 * S.leafOpen) + sway * 0.5);
        ctx.scale(dir, 1);
        leafPath(ctx, L, W);
        ctx.fill();
        ctx.restore();
      }
    }

    // Thin curly tendrils: two fine green curls that unfurl off the stem as
    // the plant grows (owner directive, 2026-07-24 — the curly green things),
    // drawn as polylines whose curvature ramps up so the tips coil tight.
    if (S.trueLeaf > 0.04) {
      ctx.strokeStyle = style.tendril;
      ctx.lineWidth = Math.max(1, size * 0.011);
      ctx.lineCap = "round";
      for (const [frac, tdir, lag] of [[0.3, -1, 0], [0.52, 1, 0.25]]) {
        const amt = clamp01((S.trueLeaf - lag) / (1 - lag));
        if (amt <= 0.02) continue;
        let tx = cx + Math.sin(sway) * h * frac * 0.2;
        let ty = groundY - h * frac;
        let ang = tdir > 0 ? -0.5 : Math.PI + 0.5;
        ang += sway * 0.4;
        const step = size * 0.017 * amt;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        for (let k = 0; k < 13; k++) {
          ang += tdir * (0.1 + k * k * 0.011);
          tx += Math.cos(ang) * step;
          ty += Math.sin(ang) * step;
          ctx.lineTo(tx, ty);
        }
        ctx.stroke();
      }
    }

    // True leaves: a larger pair mid-stem that unfurl while growing.
    if (S.trueLeaf > 0.02) {
      const ly = groundY - h * 0.7;
      const lx = tipX * 0.5 + cx * 0.5;
      const L = size * 0.16 * S.trueLeaf;
      const W = size * 0.075 * S.trueLeaf;
      ctx.fillStyle = style.leaf;
      for (const dir of [-1, 1]) {
        ctx.save();
        ctx.translate(lx, ly);
        ctx.rotate(dir * (0.7 - 0.25 * S.trueLeaf) + sway * 0.4);
        ctx.scale(dir, 1);
        leafPath(ctx, L, W);
        ctx.fill();
        ctx.restore();
      }
    }

    // The bloom: a SUNFLOWER head — a ring of pointed golden petals (two
    // golds alternating for depth) around a dark seed-filled center — opening
    // at the tip in the last beat, turned a little toward the low sun.
    if (S.bloom > 0.02) {
      const petals = 13;
      const bo = smooth(S.bloom);
      const centerR = size * 0.042 * bo;
      const petL = size * 0.088 * bo;
      const petW = size * 0.026 * bo;
      ctx.save();
      ctx.translate(tipX, tipY);
      ctx.rotate(sway * 0.5);
      for (let i = 0; i < petals; i++) {
        const ang = (i / petals) * Math.PI * 2;
        ctx.save();
        ctx.rotate(ang);
        ctx.translate(centerR * 0.8, 0);
        ctx.fillStyle = i % 2 ? style.petalDeep : style.flower;
        leafPath(ctx, petL, petW);
        ctx.fill();
        ctx.restore();
      }
      // The seed head: a dark disc with a near-black core — the same seeds
      // the release beat will shake loose.
      ctx.fillStyle = style.center;
      ctx.beginPath();
      ctx.arc(0, 0, centerR, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = style.seed;
      ctx.beginPath();
      ctx.arc(0, 0, centerR * 0.55, 0, Math.PI * 2);
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
 * Replace a small loading slot with the looping plant animation — the exact
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
 *   finish — grow the plant out, fold into the green ✓, then call onDone ONCE;
 *            a no-op mount fires onDone immediately.
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
    const groundY = size * 0.74; // the soil line the seed lands on
    const topY = size * 0.14; // where the seed starts its fall
    const maxStem = size * 0.5; // full-grown stem height
    const seedR = size * 0.055;
    /** @type {PlantGeo} */
    const geo = { cx, groundY, topY, maxStem, seedR, size, style };

    let raf = 0;
    let startMs = 0;
    let lastT = 0;
    let lastFlip = 0;
    let lastWither = 0; // the loop's current parent-fade, for a finale catch
    let witherAtFinale = 0;
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

    /** Begin the completion finale from wherever the boomerang is right now.
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
      // A parent caught mid-wither revives at the finale's start (the grow-out
      // needs a whole plant to grow); the released seed simply lets go.
      witherAtFinale = lastWither;
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
      let wither = 0;
      let seedDrop = -1; // ≥0 only while a released seed is midair
      if (mode === "finale" && plan) {
        if (!finaleStart) finaleStart = now;
        const fe = now - finaleStart;
        // Revive a mid-wither parent over the finale's opening beats.
        wither = witherAtFinale * (1 - smooth(clamp01(fe / 320)));
        if (fe < plan.runMs) {
          t = plan.runStart + (plan.runEnd - plan.runStart) * smooth(fe / plan.runMs);
          master = 1;
          sway = lastFlip * 0.4 * (1 - smooth(fe / plan.runMs));
        } else if (fe < plan.runMs + plan.holdMs) {
          t = plan.runEnd;
          master = 1;
        } else {
          t = plan.runEnd;
          master = 1;
          checkProg = clamp01((fe - plan.runMs - plan.holdMs) / plan.checkMs);
          fold = checkProg;
        }
      } else {
        const cyc = cycleStateAt(cycleDesignTime((now - startMs) * clockRate));
        t = cyc.t;
        wither = cyc.wither;
        if (cyc.releasing) seedDrop = cyc.seedDrop;
        // A gentle sway that deepens as the plant grows tall.
        sway = Math.sin((now - startMs) / 620) * (0.04 + 0.1 * (t / FULL_APEX));
        lastFlip = sway;
        lastWither = wither;
        master = smooth((now - startMs) / 260);
      }
      lastT = t;

      ctx.clearRect(0, 0, size, size);
      const S = plantStateAt(t);
      const aBase = master * (1 - smooth(checkProg));
      const a = aBase * (1 - wither);
      if (a > 0.002) {
        ctx.save();
        if (fold > 0) {
          // Fold: the grown plant shrinks toward the ✓ as the check strokes in.
          const s2 = 1 - 0.4 * smooth(fold);
          const fy = groundY - maxStem * 0.5;
          ctx.translate(cx, fy);
          ctx.scale(s2, s2);
          ctx.translate(-cx, -fy);
        }
        drawPlantFigure(ctx, geo, S, sway, a);
        ctx.restore();
      }
      if (seedDrop >= 0 && aBase > 0.002) {
        // The released handful: small black seeds shake loose from the
        // sunflower head and fall gravity-eased, each drifting to its own
        // SEED_SCATTER landing spot — exactly where the next generation's
        // settled handful sits, so the wrap is continuous.
        const tipX = cx + Math.sin(sway) * maxStem * 0.28;
        const dropTop = groundY - maxStem + seedR * 2.4; // just under the head
        ctx.save();
        ctx.globalAlpha = aBase;
        ctx.fillStyle = style.seed;
        for (let i = 0; i < SEED_SCATTER.length; i++) {
          const [ox, delay] = SEED_SCATTER[i];
          // Stronger stagger than the planting drop (×2.2) so the handful
          // trickles off the head one-by-one instead of clumping midair.
          const d2 = delay * 2.2;
          const f = clamp01((seedDrop - d2) / (1 - d2));
          if (f <= 0) continue; // still held in the head
          const fromX = tipX + ox * size * 0.75; // spread across the head
          const sx2 = fromX + (cx + ox * size - fromX) * f;
          const sy2 = dropTop + (groundY - dropTop) * f * f;
          ctx.save();
          ctx.translate(sx2, sy2);
          ctx.rotate(i * 0.9 + f * 0.6);
          ctx.beginPath();
          ctx.ellipse(0, 0, seedR * 0.62, seedR * 0.4, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
        ctx.restore();
        ctx.globalAlpha = 1;
      }
      if (checkProg > 0) drawCheck(checkProg, smooth(checkProg));

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
