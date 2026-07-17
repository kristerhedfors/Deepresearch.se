// @ts-check
// The balloon SPINNER: the blue tier's waiting symbol — the Se/rver
// counterpart of the umbrella spinner (umbrella-spinner.js), speaking the
// tier's own symbol per FEATURES.md F-16 (owner directive 2026-07-15: the
// waiting symbols correspond to the tier's landing animation, and the finale
// turns into a BLUE check mark where Se/cure's turns pink). Each loading slot
// plays the balloon intro in miniature, fixed in place: the logo vortex
// swirls, untwists into a balloon crown, its contours get drawn while the
// flag color drains, the camera swings under it — and while work is ongoing
// it BOOMERANGS just before the color revival, never reaching the colored
// balloon. Completion plays the FINALE: a speed-run forward INTO the fully
// colored blue-and-gold balloon (the beat the loop never reaches), a beat to
// live, then the fold into the blue ✓.
//
// It reuses the intro's pure timeline + geometry (balloon-intro.js) AND the
// umbrella spinner's pure boomerang/tumble clocks (umbrella-spinner.js) —
// shared math, so the tiers' waiting symbols stay siblings by construction.
// Only the plan constants (this timeline's marks) and the blue ✓ are its own.
// Same contract as mountUmbrellaSpinner: best-effort mount, {stop, finish},
// entirely fail-soft — a no-op mount still fires finish()'s callback.

import {
  BASE_SPEED,
  FLEET,
  T,
  clamp01,
  clampAnimMult,
  drawBalloonFigure,
  paramsAt,
  smooth,
} from "./balloon-intro.js";
import {
  FINALE_CHECK_MS,
  FINALE_HOLD_MS,
  FINALE_RUN_MS,
  boomerangDesignTime,
  boomerangFlip,
  canCanvas,
  reducedMotion,
} from "./umbrella-spinner.js";

// ---- pure helpers (Node-tested) ----------------------------------------------------

// The in-progress LOOP turns back JUST BEFORE the color: its apex is the
// wire balloon mid-descent, revive exactly 0 — the colored balloon is the one
// beat the loop never reaches, reserved for "done" (the umbrella discipline).
export const LOOP_APEX = T.reviveStart;

// The finale's target: the fully-revived, fully-rigged balloon seen from
// underneath — past reviveEnd and rigEnd but before the timeline's own fade.
export const BLUE_APEX = T.rigEnd;

// Phase boundaries within the loop (design ms): which of the five speed-run
// versions a completion caught at t0 uses (0 = deep vortex … 4 = descending).
const FINALE_MARKS = [T.swirlEnd, T.untwistEnd, T.wireEnd, T.dropStart];
// The runway/hold/check pacing is SHARED with the umbrella sibling (imported
// above): one felt pace across the two tiers' spinners, each with its own
// MARKS and apex.

/** Which speed-run bucket a completion caught at design-time t0 uses.
 * @param {number} t0 @returns {number} */
export function finalePhaseBucket(t0) {
  const t = Number.isFinite(t0) ? Math.max(0, t0) : 0;
  let b = 0;
  for (const m of FINALE_MARKS) if (t >= m) b++;
  return b;
}

/** The finale plan for a completion caught at design-time t0 — the speed-run
 * up to the colored balloon, the beat to hold it, the fold into the ✓. Pure
 * and deterministic; the browser just plays it out.
 * @param {number} t0
 * @returns {{bucket:number, runStart:number, runEnd:number, runMs:number,
 *            holdMs:number, checkMs:number, totalMs:number}} */
export function planFinale(t0) {
  const start = Number.isFinite(t0) ? Math.min(Math.max(0, t0), BLUE_APEX) : 0;
  const bucket = finalePhaseBucket(start);
  const runMs = FINALE_RUN_MS[bucket];
  return {
    bucket,
    runStart: start,
    runEnd: BLUE_APEX,
    runMs,
    holdMs: FINALE_HOLD_MS,
    checkMs: FINALE_CHECK_MS,
    totalMs: runMs + FINALE_HOLD_MS + FINALE_CHECK_MS,
  };
}

/** The style for the i-th loading slot: one of the intro fleet's blue-and-
 * gold schemes, cycled so adjacent slots differ (same shape — only colors
 * vary here, per the owner's same-shape call). Defensive on the index.
 * @param {number} index
 * @returns {typeof FLEET[number]} */
export function spinnerStyle(index) {
  const n = FLEET.length;
  const i = Number.isFinite(index) ? ((Math.trunc(index) % n) + n) % n : 0;
  return FLEET[i];
}

// ---- the DOM layer (browser only) --------------------------------------------------

const CHECK_BLUE = "#0d4fa0"; // the finale's ✓ — app.css --check-blue, so the
// canvas ✓ hands off seamlessly to the real .check span the caller swaps in.
// The balloon is Se/rver's OWN symbol (docs/SYMBOL-LANGUAGE.md §6, 2026-07-16:
// each tier wears its own symbol; Se/cure's is the umbrella spinner).

// canCanvas / reducedMotion come from the umbrella sibling (imported above).

/**
 * Replace a small loading slot with the looping single-balloon animation —
 * the exact contract of mountUmbrellaSpinner (turns.js/activity.js swap the
 * import and change nothing else): best-effort mount that leaves the CSS
 * spinner untouched on reduced-motion/no-canvas, a canvas centered over the
 * host and allowed to overflow, self-terminating once the host leaves the
 * document.
 *
 * @param {HTMLElement} host  the `.spin` / `.typing-icon` element
 * @param {{ size?: number, style?: number, speed?: number }} [opts]
 * @returns {{ stop: () => void, finish: (onDone?: () => void) => void }}
 *   stop   — tear down immediately (no finale), for cancel/settle paths.
 *   finish — speed-run into the colored balloon, fold into the blue ✓,
 *            then call onDone ONCE; a no-op mount fires onDone immediately.
 */
export function mountBalloonSpinner(host, opts = {}) {
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

    const R = size * 0.26; // envelope radius; leaves room for the basket below
    const cx = size / 2;
    const cy = size * 0.44; // anchored a touch high so the rig hangs into view

    let spin = 0;
    let raf = 0;
    let start = 0;
    let lastT = 0;
    let lastFlip = 0;
    let stopped = false;

    let mode = /** @type {"loop"|"finale"} */ ("loop");
    let finaleStart = 0;
    let plan = /** @type {ReturnType<typeof planFinale>|null} */ (null);
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
      plan = planFinale(lastT);
      finaleStart = 0;
      mode = "finale";
    }

    /** The blue ✓ the balloon folds into — same geometry as the umbrella
     * spinner's ✓, in the tier's accent so it hands off to the CSS .check.
     * @param {number} prog @param {number} a */
    function drawCheck(prog, a) {
      if (!ctx || a <= 0.001) return;
      const h = R * 1.05;
      const ccx = cx;
      const ccy = cy + R * 0.12;
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
      ctx.strokeStyle = CHECK_BLUE;
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
      if (!start) {
        start = now;
        lastT = 0;
      }

      let t;
      let master;
      let fold = 0;
      let checkProg = 0;
      let flipA = 0;
      if (mode === "finale" && plan) {
        if (!finaleStart) finaleStart = now;
        const fe = now - finaleStart;
        if (fe < plan.runMs) {
          t = plan.runStart + (plan.runEnd - plan.runStart) * smooth(fe / plan.runMs);
          master = 1;
          flipA = lastFlip * (1 - smooth(fe / plan.runMs));
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
        t = boomerangDesignTime(now - start, clockRate, LOOP_APEX);
        flipA = boomerangFlip(now - start, clockRate, LOOP_APEX);
        lastFlip = flipA;
        master = smooth((now - start) / 250);
      }

      // Spin integrates on the delta's MAGNITUDE (the boomerang rewind keeps
      // turning the one way), clamped against background-tab time jumps.
      let dtd = t - lastT;
      lastT = t;
      const cap = 60 * clockRate;
      if (dtd > cap) dtd = cap;
      else if (dtd < -cap) dtd = -cap;
      spin += (style.dir || 1) * (style.speed || 1) * paramsAt(t).spinRate * 0.0016 * Math.abs(dtd);

      ctx.clearRect(0, 0, size, size);
      const P = paramsAt(t);
      const a = master * (1 - smooth(checkProg));
      if (a > 0.002) {
        ctx.save();
        if (fold > 0) {
          const s2 = 1 - 0.4 * smooth(fold);
          ctx.translate(cx, cy);
          ctx.scale(s2, s2);
          ctx.translate(-cx, -cy);
        }
        // The tumble rides as the figure's sway — the turnaround somersault.
        drawBalloonFigure(ctx, { cx, cy, R, style, P, spin, sway: flipA, alpha: a, t });
        ctx.restore();
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
