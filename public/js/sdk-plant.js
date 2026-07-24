// @ts-check
// SPROUT — SDK mode's theme character. The fourth member of the site's cast of
// one-shot greeters (Se/cure's strolling ghost, Se/rver's balloon guide,
// introspection's TIN mascot), appearing the FIRST time a user enters SDK mode
// (the green "lovable distiller"): a little plant grows in the corner above the
// composer, says what this mode does, and retires — no persistent figure (the
// owner directive the whole cast follows). It GROWS in from nothing straight to
// full bloom — no seed, no soil, nothing brown (owner directive, 2026-07-24) —
// echoing the plant
// spinner's own animation, and it draws with the SAME shared renderer
// (drawPlantFigure, plant-spinner.js) so the character and the waiting symbol
// are the same plant by construction — the family rule.
//
// Decoration ONLY, entirely fail-soft: a small fixed canvas + a plain-text
// bubble, both pointer-events:none and aria-hidden, so every tap dismisses it
// (UX-1) yet still reaches the app underneath. Shown once per browser
// (localStorage), static under prefers-reduced-motion, paused while the tab is
// hidden, and it never touches the boot/chat path. Styled inline so no
// stylesheet handshake (CSS_VERSION) is involved.

import {
  FULL_APEX,
  clamp01,
  drawPlantFigure,
  plantStateAt,
  smooth,
  spinnerStyle,
} from "./plant-spinner.js";

/** localStorage flag: the greeter is a once-per-browser first-entry event. */
export const SDK_GREET_KEY = "dr_sdk_greeted";

/** The pointer lines SPROUT speaks — plain text, one per beat. */
export const SDK_GREETER_LINES = [
  "Agent Studio — describe an agent and I distil this site into it.",
  "It grows into a new flavour, published live at its own link.",
];

const BOX_W = 92;
const BOX_H = 118;
const GROW_MS = 2200; // real ms for the sprout to appear and grow to bloom
const LINE_MS = 3600; // how long each pointer line lingers
const SETTLE_MS = 820; // grown, then the first line
const DEPART_MS = 620; // fade-out on the way out

/** Growth design-time for the greeter at real `elapsed` ms — eases from
 * nothing into full bloom over GROW_MS, then pins at full. Pure/testable.
 * @param {number} elapsed @param {number} [dur] @returns {number} design-ms */
export function greeterGrowth(elapsed, dur = GROW_MS) {
  const e = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
  const d = dur > 0 ? dur : GROW_MS;
  return FULL_APEX * smooth(clamp01(e / d));
}

/** @type {null | { canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D,
 *  start: number, departAt: number, raf: number, reduced: boolean,
 *  bubble: HTMLElement|null, timers: number[], dismiss: (e?: Event) => void }} */
let guide = null;

function clearTimers() {
  if (!guide) return;
  for (const t of guide.timers) clearTimeout(t);
  guide.timers = [];
}

function unmount() {
  const g = guide;
  guide = null;
  if (!g) return;
  try {
    if (g.raf) cancelAnimationFrame(g.raf);
    for (const t of g.timers) clearTimeout(t);
    document.removeEventListener("pointerdown", g.dismiss, true);
    g.canvas?.remove();
    g.bubble?.remove();
  } catch {
    /* nothing to clean up */
  }
}

/** Begin the fade-out departure (idempotent). */
function depart() {
  const g = guide;
  if (!g || g.departAt >= 0) return;
  try {
    g.departAt = performance.now();
    clearTimers();
    if (g.bubble) g.bubble.style.opacity = "0";
    g.canvas.style.transition = `opacity ${DEPART_MS}ms ease`;
    g.canvas.style.opacity = "0";
    g.timers.push(window.setTimeout(unmount, DEPART_MS + 40));
  } catch {
    unmount();
  }
}

/** Show the next pointer line, or leave when the script is done. @param {number} i */
function speak(i) {
  const g = guide;
  if (!g || g.departAt >= 0) return;
  try {
    if (i >= SDK_GREETER_LINES.length) {
      depart();
      return;
    }
    let el = g.bubble;
    if (!el) {
      el = document.createElement("div");
      el.setAttribute("aria-hidden", "true");
      // Glass over the SDK green palette, floating to the LEFT of the plant.
      // Inert to input — the document-level dismiss handles UX-1.
      el.style.cssText =
        "position:fixed;right:96px;bottom:9.4rem;max-width:238px;z-index:5;" +
        "pointer-events:none;background:rgba(246,253,248,.94);color:#12432c;" +
        "border:1px solid rgba(31,138,76,.38);border-radius:12px;border-bottom-right-radius:3px;" +
        "padding:.55rem .7rem;font-size:.82rem;line-height:1.4;transition:opacity .3s ease;" +
        "box-shadow:0 6px 22px rgba(20,70,45,.18);";
      document.body.appendChild(el);
      g.bubble = el;
    }
    el.textContent = SDK_GREETER_LINES[i]; // plain text, no markup
    el.style.opacity = "1";
    g.timers.push(window.setTimeout(() => speak(i + 1), LINE_MS));
  } catch {
    unmount();
  }
}

/** @param {number} now */
function frame(now) {
  const g = guide;
  if (!g || !g.ctx) return;
  if (!g.canvas.isConnected) return unmount();
  if (document.hidden) {
    g.raf = requestAnimationFrame(frame);
    return;
  }
  try {
    const elapsed = now - g.start;
    const t = greeterGrowth(elapsed);
    const S = plantStateAt(t);
    // A gentle sway once grown; none while it is still growing in.
    const grown = t >= FULL_APEX * 0.9;
    const sway = grown ? Math.sin(now / 720) * 0.06 : 0;
    g.ctx.clearRect(0, 0, BOX_W, BOX_H);
    drawPlantFigure(
      g.ctx,
      {
        cx: BOX_W / 2,
        groundY: BOX_H * 0.86,
        maxStem: BOX_H * 0.6,
        size: BOX_W,
        style: spinnerStyle(0),
      },
      S,
      sway,
      1,
    );
  } catch {
    return unmount();
  }
  g.raf = requestAnimationFrame(frame);
}

/**
 * The one-shot first-entry greeter (idempotent; no-ops outside a browser or
 * after the first time). app.js calls it when the user picks SDK mode. Grows
 * the plant in, delivers the pointer lines, then fades away and unmounts.
 */
export function showSdkPlantGreeter() {
  if (guide || typeof document === "undefined") return;
  try {
    if (localStorage.getItem(SDK_GREET_KEY) === "1") return;
  } catch {
    /* storage unavailable — fall through and show it this once */
  }
  let canvas = null;
  try {
    canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = BOX_W * dpr;
    canvas.height = BOX_H * dpr;
    // Below every overlay/panel (z-index 10+) and inert to input; sits above
    // the composer's right corner.
    canvas.style.cssText =
      `position:fixed;right:6px;bottom:7.4rem;width:${BOX_W}px;height:${BOX_H}px;` +
      "z-index:5;pointer-events:none;";
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    document.body.appendChild(canvas);
    try {
      localStorage.setItem(SDK_GREET_KEY, "1");
    } catch {
      /* the once-flag is best-effort */
    }
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dismiss = () => depart();
    guide = {
      canvas,
      ctx,
      start: performance.now(),
      departAt: -1,
      raf: 0,
      reduced,
      bubble: null,
      timers: [],
      dismiss,
    };
    if (reduced) {
      // Static: draw the grown plant once, say the lines, no animation loop.
      const S = plantStateAt(FULL_APEX);
      drawPlantFigure(
        ctx,
        {
          cx: BOX_W / 2,
          groundY: BOX_H * 0.86,
          maxStem: BOX_H * 0.6,
          size: BOX_W,
          style: spinnerStyle(0),
        },
        S,
        0,
        1,
      );
    } else {
      guide.raf = requestAnimationFrame(frame);
    }
    guide.timers.push(window.setTimeout(() => speak(0), reduced ? 200 : GROW_MS + SETTLE_MS));
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("visibilitychange", () => {
      if (guide && !guide.reduced && !document.hidden) {
        cancelAnimationFrame(guide.raf);
        guide.raf = requestAnimationFrame(frame);
      }
    });
  } catch {
    try {
      canvas?.remove();
    } catch {
      /* nothing to clean up */
    }
    guide = null;
  }
}
