// @ts-check
// The COIN spinner: the Se/rver app's waiting symbol wherever the 3D canvas
// symbols (the balloon, the plant) cannot be drawn — no canvas, an SSR/Node
// host, a mount that threw. There the site ICON itself is the spinner (the
// `.spin` / `.typing-icon` background in css/app.css), and since 2026-08-14 it
// spins the way a COIN spins on a flat surface: upright on its rim, turning
// about the vertical axis, the face sweeping toward the viewer and away again.
//
// Completion is the coin SETTLING, not a snap: the turn keeps going while the
// tilt grows, the rattle gets faster and wobblier the flatter it gets, and the
// coin comes to rest LYING FLAT — face up, seen from 30° above the surface
// (`COIN_TILT_DEG` = 60° of rotateX; a horizontal disc viewed from elevation θ
// foreshortens by sin θ, and cos 60° = sin 30°). It holds there a beat and
// fades as the real ✓ takes its place.
//
// The motion is CSS (css/app.css `coin-spin` / `coin-land` / `coin-rest`); this
// module is the CLOCK — it hands the keyframes the angle the coin is at right
// now, how far it must still turn to land face-on, and the three durations. The
// pacing constants are IMPORTED from umbrella-spinner.js, not re-picked here, so
// the coin is a sibling of the umbrella / balloon / plant finales by
// construction rather than by a comment claiming so (the SYMBOL-LANGUAGE §6
// discipline: one felt pace across every waiting symbol).
//
// Same contract as mountBalloonSpinner / mountPlantSpinner / mountUmbrellaSpinner:
// best-effort mount, {stop, finish}, entirely fail-soft — a no-op mount still
// fires finish()'s callback, so the caller's ✓ never depends on the decoration.

import { clampAnimMult } from "../cure/umbrella.js";
import {
  FINALE_CHECK_MS,
  FINALE_HOLD_MS,
  FINALE_RUN_MS,
  reducedMotion,
} from "./umbrella-spinner.js";

// ---- pure helpers (Node-tested) ----------------------------------------------------

/** One revolution of the in-progress loop, in ms at anim multiplier 1. Slow
 * enough that the face is readable as it comes round, fast enough to read as
 * "working" — matched to the css/app.css `--coin-spin-ms` default. */
export const COIN_SPIN_MS = 1150;

/** The landed tilt: a disc lying on a flat surface seen from 30° ABOVE that
 * surface (cos 60° = sin 30° = the foreshortening a 30° elevation gives). The
 * one number the whole "ends lying flat" beat is about — css/app.css's
 * `coin-land` 100% stop MUST match it. */
export const COIN_TILT_DEG = 60;

/** Extra full turns the coin makes while settling, on top of finishing the
 * revolution it was caught mid-way through. The landing always ends face-on
 * (a whole number of turns), because a coin coming to rest edge-on is not a
 * coin coming to rest. */
export const COIN_SETTLE_TURNS = 2;

/** Phase boundaries within one revolution, as a FRACTION of the turn — the
 * coin analog of umbrella-spinner.js's FINALE_MARKS. A completion caught just
 * after the face came round (phase ≈ 0) has the whole revolution left to
 * finish before it can settle face-on, so it gets the longest runway; one
 * caught with the face nearly back (phase ≈ 1) gets the shortest. */
const COIN_MARKS = [0.2, 0.4, 0.6, 0.8];

/** Where the coin is in its current revolution: 0 = face-on toward the viewer,
 * .5 = face-on away, 1 = back to the start. Defensive against a garbage clock.
 * @param {number} elapsedMs  ms since mount
 * @param {number} [spinMs]   one revolution in ms
 * @returns {number} 0 ≤ phase < 1 */
export function coinPhase(elapsedMs, spinMs = COIN_SPIN_MS) {
  const period = Number.isFinite(spinMs) && spinMs > 0 ? spinMs : COIN_SPIN_MS;
  const t = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  return (t % period) / period;
}

/** The coin's current angle about the vertical axis, in degrees [0, 360).
 * @param {number} elapsedMs @param {number} [spinMs] @returns {number} */
export function spinAngleAt(elapsedMs, spinMs = COIN_SPIN_MS) {
  return coinPhase(elapsedMs, spinMs) * 360;
}

/** Which of the five settle versions a completion caught at `phase` uses
 * (0 = the face just left … 4 = the face is nearly back). Mirrors
 * umbrella-spinner.js finalePhaseBucket over fractions instead of design-ms.
 * @param {number} phase @returns {number} */
export function coinLandingBucket(phase) {
  const p = Number.isFinite(phase) ? Math.min(Math.max(0, phase), 1) : 0;
  let b = 0;
  for (const m of COIN_MARKS) if (p >= m) b++;
  return b;
}

/** How far (degrees) the coin must still turn to come to rest FACE-ON: the
 * remainder of the revolution it is in, plus COIN_SETTLE_TURNS whole turns of
 * settling. Always > 0, always a whole number of turns away from the start
 * angle, so `startDeg + turnDeg` is face-on.
 * @param {number} phase @returns {number} */
export function landingTurnDeg(phase) {
  const p = Number.isFinite(phase) ? Math.min(Math.max(0, phase), 1) : 0;
  return (1 - p) * 360 + COIN_SETTLE_TURNS * 360;
}

/**
 * The landing plan for a completion caught at `phase` of the current
 * revolution: the settle runway (spin down, tilt over, rattle flat), the beat
 * the landed coin is held, and the fade the real ✓ arrives through. The three
 * durations are the SHARED finale pacing (umbrella-spinner.js) — the coin
 * differs only in what it does with them.
 * @param {number} phase
 * @returns {{bucket:number, startPhase:number, turnDeg:number, runMs:number,
 *            holdMs:number, checkMs:number, totalMs:number}}
 */
export function planCoinLanding(phase) {
  const p = Number.isFinite(phase) ? Math.min(Math.max(0, phase), 1) : 0;
  const bucket = coinLandingBucket(p);
  const runMs = FINALE_RUN_MS[bucket];
  return {
    bucket,
    startPhase: p,
    turnDeg: landingTurnDeg(p),
    runMs,
    holdMs: FINALE_HOLD_MS,
    checkMs: FINALE_CHECK_MS,
    totalMs: runMs + FINALE_HOLD_MS + FINALE_CHECK_MS,
  };
}

// ---- the DOM layer (browser only) --------------------------------------------------

/** The custom properties css/app.css reads. Kept in one place so `stop()` can
 * clear exactly what `mount`/`finish` set — a host outlives its spinner (the
 * `.spin` span is reused when a step's label is rewritten in place). */
const COIN_VARS = [
  "--coin-spin-ms",
  "--coin-from",
  "--coin-turn",
  "--coin-land-ms",
  "--coin-rest-ms",
  "--coin-rest-delay",
];

/** The class css/app.css hangs the settle on. */
export const LANDING_CLASS = "coin-landing";

/** Monotonic-ish clock; performance.now where it exists, Date.now otherwise. */
function now() {
  return typeof performance === "object" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/** The angle the CSS animation is ACTUALLY at, read off the running animation
 * when the Web Animations API exposes it (the loop starts at first style
 * resolution, not at mount, so the elapsed-time estimate is a frame or two
 * out and the settle would start with a visible jump). Falls back to the
 * elapsed-time estimate.
 * @param {HTMLElement} host @param {number} elapsedMs @param {number} spinMs
 * @returns {number} degrees [0, 360) */
function liveSpinAngle(host, elapsedMs, spinMs) {
  try {
    const anims =
      typeof (/** @type {any} */ (host).getAnimations) === "function"
        ? /** @type {any} */ (host).getAnimations()
        : [];
    for (const a of anims) {
      const t = a && a.currentTime;
      if (typeof t === "number" && Number.isFinite(t)) return spinAngleAt(t, spinMs);
    }
  } catch {
    /* no WAAPI (or a throwing polyfill) — the estimate is good enough */
  }
  return spinAngleAt(elapsedMs, spinMs);
}

/**
 * Drive the CSS coin on a small loading slot. Unlike its canvas siblings this
 * mounts NOTHING — the icon is already the spinner (css/app.css); the handle
 * only owns its clock and its settle. Best-effort: on reduced motion it leaves
 * the quiet idle pulse alone and returns a no-op handle, so an accessibility
 * preference is never overridden by a flourish.
 *
 * @param {HTMLElement} host  the `.spin` / `.typing-icon` element
 * @param {{ size?: number, style?: number, speed?: number }} [opts]
 *   speed — the admin anim multiplier (1 = default); `size`/`style` are
 *   accepted and ignored, so the mode dispatch can pass one options object to
 *   whichever symbol it picks.
 * @returns {{ stop: () => void, finish: (onDone?: () => void) => void }}
 *   stop   — back to the plain loop immediately (no settle), for cancel paths.
 *   finish — settle the coin flat, hold it a beat, fade it out, then call
 *            onDone ONCE; a no-op mount fires onDone immediately.
 */
export function mountLogoSpinner(host, opts = {}) {
  const noop = {
    stop: () => {},
    /** @param {(() => void)=} onDone */
    finish: (onDone) => {
      if (typeof onDone === "function") onDone();
    },
  };
  try {
    if (!host || typeof document === "undefined" || !host.style) return noop;
    // Reduced motion: css/app.css already replaces the spin with a still,
    // opacity-only pulse. Nothing to settle, so the ✓ arrives at once.
    if (reducedMotion()) return noop;

    const spinMs = Math.max(1, Math.round(COIN_SPIN_MS / clampAnimMult(opts.speed)));
    host.style.setProperty("--coin-spin-ms", `${spinMs}ms`);
    const t0 = now();
    /** @type {any} */
    let timer = null;
    let done = false;

    const clearVars = () => {
      try {
        host.classList.remove(LANDING_CLASS);
        for (const v of COIN_VARS) host.style.removeProperty(v);
      } catch {
        /* the host may already be detached — nothing to clean */
      }
    };

    return {
      stop() {
        if (timer) clearTimeout(timer);
        timer = null;
        done = true;
        clearVars();
      },
      /** @param {(() => void)=} onDone */
      finish(onDone) {
        const fire = () => {
          if (done) return;
          done = true;
          timer = null;
          if (typeof onDone === "function") onDone();
        };
        if (done) return; // already stopped/settled — the ✓ has been handled
        try {
          const from = liveSpinAngle(host, now() - t0, spinMs);
          const plan = planCoinLanding(from / 360);
          host.style.setProperty("--coin-from", `${from.toFixed(2)}deg`);
          host.style.setProperty("--coin-turn", `${plan.turnDeg.toFixed(2)}deg`);
          host.style.setProperty("--coin-land-ms", `${plan.runMs}ms`);
          host.style.setProperty("--coin-rest-ms", `${plan.checkMs}ms`);
          host.style.setProperty("--coin-rest-delay", `${plan.runMs + plan.holdMs}ms`);
          host.classList.add(LANDING_CLASS);
          timer = setTimeout(fire, plan.totalMs);
        } catch {
          fire(); // the settle is decoration; the checkmark is not
        }
      },
    };
  } catch {
    return noop;
  }
}
