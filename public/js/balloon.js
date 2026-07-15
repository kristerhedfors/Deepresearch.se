// @ts-check
// The Se/rver BALLOON GREETER — the blue tier's symbol character (FEATURES.md
// F-16, owner's pick 2026-07-15 from the docs/symbol-language/proposals.html
// candidates). Where Se/cure has the ghost (anonymity, holding the pink
// umbrellas), Se/rver has a little hot-air balloon in the logotype's
// gold-and-blue: the umbrellas' geometric sibling — the same gored canopy,
// but POWERED and RISING. It says the true thing about this tier: the server
// carries the load.
//
// FIRST-VISIT ONLY (owner directive, 2026-07-15, round 4): no site has a
// persistent figure following the user around. The balloon appears ONCE,
// right after the first-visit landing intro (balloon-intro.js — app.js chains
// it onto the intro's onDone, the exact gate /cure uses for its strolling
// ghost), delivers a couple of POINTER lines on how the tier works in a small
// speech bubble, then climbs away through clouds and unmounts. Returning
// visitors get a clean page. While it is on screen it still speaks the
// umbrella grammar:
//   - per COMPLETED TASK (stream.js's `done` event): the burner flares gold,
//     the balloon climbs a notch, a pennant unfurls under the basket — and
//     clouds swish DOWNWARD past it (the relative motion of the climb).
//   - on its other transitions — swishing in, departing — clouds cross the
//     box (owner directive: it swishes by clouds in ALL of its transitions).
//   - ambient (for its short stay): a gentle bob, two small drifting clouds.
//
// Structured like umbrella.js: a PURE core (everything above the DOM layer —
// Node-tested in balloon.test.js) and a browser-only DOM layer (one small
// fixed canvas, pointer-events:none, aria-hidden). Decoration ONLY: every
// public entry point is fail-soft, `prefers-reduced-motion` gets a static
// balloon with no clouds or flare, and nothing downstream awaits it. The
// bubble is plain text (no interactive content), so per UX-1 a click/tap
// ANYWHERE dismisses the greeter — the pointer-events:none layers never eat
// the click meant for the app underneath.

import { wmHtml } from "./drc-page-core.js";

// ---- the pure core -----------------------------------------------------------

// The logotype's colors on the canopy; the same basket/cream family the
// proposals page established.
export const PALETTE = {
  gold: "#f5c518",
  blue: "#1a56b0",
  ink: "#0a2e5c",
  basket: "#a97b46",
  cream: "#fff6c9",
};

export const GORES = 8; // matches the logo vortex / umbrella panel count
export const FLARE_MS = 900; // burner flare decay
export const SWISH_MS = 1100; // one cloud-swish transition
export const RISE_STEP = 9; // px climbed per completed task…
export const RISE_MAX = 27; // …capped so the greeter stays in its corner
export const PENNANT_MAX = 6; // the visible pennant tail stops growing here

// The greeter's pointer script: what the balloon says on a first visit, in
// order. Short and squarely on how THIS tier works — the sibling of the /cure
// ghost's greeting (which explains Se/cure and points back here). Plain text;
// the DOM layer renders wordmarks through wmHtml.
export const GREETER_LINES = [
  "Ask anything — Se/rver researches the live web for you. The slider sets how long it digs.",
  "Want nothing to leave your browser? The ghost button, top right, is the door to Se/cure.",
];
export const LINE_MS = 6000; // each pointer line's time on screen
export const DEPART_MS = 1600; // the climb-away-and-unmount transition

/** Departure progress 0..1, `since` ms after the greeter starts leaving:
 * eased, monotone, complete by DEPART_MS (the DOM layer unmounts at 1).
 * @param {number} since */
export function departProgress(since) {
  return smooth(since / DEPART_MS);
}

/** @param {number} v */
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** @param {number} v */
export const smooth = (v) => {
  v = clamp01(v);
  return v * v * (3 - 2 * v);
};

/**
 * Envelope half-width profile at s (0 = crown → 1 = neck), as a fraction of
 * the balloon radius: bulge high, narrow neck (the proposals-page shape).
 * @param {number} s
 */
export function prof(s) {
  s = clamp01(s);
  return 0.02 + (0.997 * Math.pow(s, 0.55) * Math.pow(1 - s, 0.75)) / 0.412 + 0.1 * s;
}

/** The ambient hover bob (px) at clock t. @param {number} t @param {number} phase */
export function bobY(t, phase = 0) {
  return Math.sin(t * 0.0011 + phase) * 3.5;
}

/** Cumulative climb (px) after n completed tasks. @param {number} n */
export function riseOffset(n) {
  return Math.min(Math.max(0, n) * RISE_STEP, RISE_MAX);
}

/** Pennants shown on the tail after n tasks. @param {number} n */
export function pennantCount(n) {
  return Math.min(Math.max(0, Math.floor(n)), PENNANT_MAX);
}

/** Burner-flare intensity 0..1, `since` ms after the task. @param {number} since */
export function flareLevel(since) {
  return since < 0 ? 0 : Math.max(0, 1 - since / FLARE_MS);
}

/**
 * A deterministic burst of swish clouds for one transition. Each cloud gets
 * a lane (0..1 across the crossed axis), a scale, and a delay/speed pair
 * chosen so EVERY cloud completes its crossing within the swish (see
 * cloudPos). Deterministic per seed so the unit suite can pin it.
 * @param {number} n @param {number} seed
 * @returns {{lane:number, scale:number, delay:number, speed:number}[]}
 */
export function swishClouds(n, seed = 1) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  return Array.from({ length: n }, () => {
    const delay = rnd() * 0.3;
    return {
      lane: 0.1 + rnd() * 0.8,
      scale: 0.5 + rnd() * 0.8,
      // speed ≥ (1 + delay) guarantees the crossing finishes by p = 1.
      speed: 1 + delay + 0.35 + rnd() * 0.5,
      delay,
    };
  });
}

/**
 * A swish cloud's position along its crossing, as a fraction -0.25 → 1.25 of
 * the crossed dimension (starts just off one edge, ends just off the other).
 * `p` is the transition's progress 0..1.
 * @param {{delay:number, speed:number}} c @param {number} p
 */
export function cloudPos(c, p) {
  return -0.25 + 1.5 * clamp01(p * c.speed - c.delay);
}

// ---- the DOM layer (browser only) ---------------------------------------------

// Canvas footprint — small and out of the way, above the composer on the
// right, below every overlay/panel (they sit at z-index 10+).
const BOX_W = 96;
const BOX_H = 150;

/** @type {{canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D,
 *          tasks: number, flareAt: number, swish: {t0:number, dir:"x"|"y",
 *          clouds:{lane:number,scale:number,delay:number,speed:number}[]}|null,
 *          rise: number, reduced: boolean, raf: number, departAt: number,
 *          bubble: HTMLElement|null, timers: number[],
 *          dismiss: ((e: Event) => void)|null}|null} */
let guide = null;

/** One puffy cloud (three overlapping discs), centered at x,y.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x @param {number} y @param {number} r @param {number} alpha */
function puff(ctx, x, y, r, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = "#ffffff";
  for (const [dx, dy, rr] of [[-r * 0.8, 0, r * 0.72], [0, -r * 0.4, r], [r * 0.85, 0, r * 0.66]]) {
    ctx.beginPath();
    ctx.arc(x + dx, y + dy, rr, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Draw the whole guide at clock t. @param {number} t */
function draw(t) {
  const g = guide;
  if (!g) return;
  const { ctx } = g;
  ctx.clearRect(0, 0, BOX_W, BOX_H);

  const flare = g.reduced ? 0 : flareLevel(t - g.flareAt);
  // The climb eases toward its per-task target; reduced motion jumps there.
  const targetRise = riseOffset(g.tasks);
  g.rise = g.reduced ? targetRise : g.rise + (targetRise - g.rise) * 0.05;

  // Swish progress (null when idle). Vertical swish = the climb's relative
  // motion (clouds streak downward); horizontal = appear/reset.
  let sw = null;
  if (g.swish && !g.reduced) {
    const p = (t - g.swish.t0) / SWISH_MS;
    if (p >= 1) g.swish = null;
    else sw = { p, dir: g.swish.dir, clouds: g.swish.clouds };
  }

  const cx = BOX_W / 2;
  const R = 26; // balloon radius
  const EH = R * 2.05; // envelope height
  const bob = g.reduced ? 0 : bobY(t);
  // Departing: the whole figure eases up and out of the box through the swish.
  const depart = g.departAt >= 0 ? departProgress(t - g.departAt) * (BOX_H + 60) : 0;
  const top = BOX_H - 66 - EH - g.rise + bob - depart;

  // ambient clouds behind the balloon — it hovers AMONG them
  if (!g.reduced) {
    const drift = (t * 0.006) % (BOX_W + 60);
    puff(ctx, ((drift + 20) % (BOX_W + 60)) - 30, top + EH * 0.25, 8, 0.5);
    puff(ctx, BOX_W - (((drift * 0.7 + 70) % (BOX_W + 60)) - 30), top + EH + 14, 6.5, 0.45);
  }

  // swish clouds crossing the box (behind the balloon)
  if (sw) {
    for (const c of sw.clouds) {
      const q = cloudPos(c, sw.p);
      if (q <= -0.24 || q >= 1.24) continue;
      const fade = Math.sin(Math.PI * clamp01((q + 0.25) / 1.5));
      if (sw.dir === "y") puff(ctx, c.lane * BOX_W, q * BOX_H, 8 * c.scale, 0.75 * fade);
      else puff(ctx, q * BOX_W, c.lane * BOX_H, 8 * c.scale, 0.75 * fade);
    }
  }

  // -- the balloon ---------------------------------------------------------
  const spin = g.reduced ? 0.35 : t * 0.00018; // gores drift lazily, umbrella-style
  const STEPS = 12;
  /** @param {number} th @param {number} s */
  const edge = (th, s) => cx + prof(s) * R * 1.35 * Math.sin(th);
  const seamStep = Math.PI / GORES;
  for (let k = 0; k < GORES * 2; k++) {
    const a0 = k * seamStep + spin;
    const a1 = a0 + seamStep;
    const mid = (a0 + a1) / 2;
    if (Math.cos(mid) <= 0.02) continue; // back-facing gore
    ctx.beginPath();
    for (let i = 0; i <= STEPS; i++) {
      const s = i / STEPS;
      ctx[i ? "lineTo" : "moveTo"](edge(a0, s), top + s * EH);
    }
    for (let i = STEPS; i >= 0; i--) {
      const s = i / STEPS;
      ctx.lineTo(edge(a1, s), top + s * EH);
    }
    ctx.closePath();
    ctx.fillStyle = k % 2 ? PALETTE.blue : PALETTE.gold;
    ctx.globalAlpha = 0.55 + 0.45 * Math.cos(mid); // shade toward the limb
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  // silhouette
  ctx.beginPath();
  for (let i = 0; i <= STEPS; i++) {
    const s = i / STEPS;
    ctx[i ? "lineTo" : "moveTo"](cx - prof(s) * R * 1.35, top + s * EH);
  }
  for (let i = STEPS; i >= 0; i--) {
    const s = i / STEPS;
    ctx.lineTo(cx + prof(s) * R * 1.35, top + s * EH);
  }
  ctx.closePath();
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // basket + rigging
  const neckY = top + EH;
  const nw = prof(1) * R * 1.35;
  const bw = R * 0.36;
  const bh = R * 0.28;
  const by = neckY + R * 0.32;
  ctx.strokeStyle = PALETTE.ink;
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.moveTo(cx - nw, neckY);
  ctx.lineTo(cx - bw / 2, by);
  ctx.moveTo(cx + nw, neckY);
  ctx.lineTo(cx + bw / 2, by);
  ctx.stroke();
  ctx.fillStyle = PALETTE.basket;
  ctx.fillRect(cx - bw / 2, by, bw, bh);
  ctx.strokeRect(cx - bw / 2, by, bw, bh);

  // burner flare — the per-task celebration
  if (flare > 0.01) {
    const fy = neckY + R * 0.14;
    const fr = R * 0.55 * flare + 4;
    const grad = ctx.createRadialGradient(cx, fy, 1, cx, fy, fr);
    grad.addColorStop(0, "rgba(255,240,150,.95)");
    grad.addColorStop(0.5, "rgba(245,197,24,.55)");
    grad.addColorStop(1, "rgba(245,197,24,0)");
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, fy, fr, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // the pennant tail: one little flag per completed task (capped)
  const n = pennantCount(g.tasks);
  if (n > 0) {
    const px = cx + bw / 2 + 2;
    ctx.strokeStyle = PALETTE.ink;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(px, by + bh * 0.3);
    ctx.lineTo(px, by + bh * 0.3 + n * 9 + 3);
    ctx.stroke();
    for (let i = 0; i < n; i++) {
      const py = by + bh * 0.3 + 4 + i * 9 + (g.reduced ? 0 : Math.sin(t * 0.003 + i) * 0.8);
      ctx.fillStyle = i % 2 ? PALETTE.gold : "#f2f9ff";
      ctx.beginPath();
      ctx.moveTo(px, py - 2.6);
      ctx.lineTo(px + 8, py);
      ctx.lineTo(px, py + 2.6);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }
}

/** Tear the greeter down completely: canvas, bubble, timers, listeners. */
function unmount() {
  const g = guide;
  if (!g) return;
  guide = null;
  try {
    cancelAnimationFrame(g.raf);
    for (const id of g.timers) clearTimeout(id);
    if (g.dismiss) document.removeEventListener("pointerdown", g.dismiss, true);
    g.bubble?.remove();
    g.canvas.remove();
  } catch {
    // best-effort cleanup — nothing downstream depends on it
  }
}

/** @param {number} now */
function frame(now) {
  const g = guide;
  if (!g) return;
  // The greeter is decoration on a tiny canvas, but it must never be the
  // thing that breaks the app: any draw error unmounts it cleanly.
  try {
    if (!document.hidden) draw(now);
    if (g.departAt >= 0 && now - g.departAt >= DEPART_MS) {
      unmount(); // climbed out of the box — the visit is over
      return;
    }
    if (g.reduced && !g.swish && flareLevel(now - g.flareAt) <= 0) return; // static — stop looping
    g.raf = requestAnimationFrame(frame);
  } catch {
    unmount();
  }
}

/** Kick a swish transition. @param {"x"|"y"} dir */
function startSwish(dir) {
  const g = guide;
  if (!g || g.reduced) return;
  g.swish = { t0: performance.now(), dir, clouds: swishClouds(5, (Date.now() & 0xffff) | 1) };
}

/** Start leaving: hide the bubble, climb up through a downward cloud swish,
 * unmount when the climb completes (reduced motion unmounts right away). */
function depart() {
  const g = guide;
  if (!g || g.departAt >= 0) return;
  try {
    g.bubble?.remove();
    g.bubble = null;
    if (g.reduced) {
      unmount();
      return;
    }
    g.departAt = performance.now();
    startSwish("y"); // clouds streak downward as it climbs away
  } catch {
    unmount();
  }
}

/** Show the next pointer line (or leave when the script is done).
 * @param {number} i */
function speak(i) {
  const g = guide;
  if (!g || g.departAt >= 0) return; // already leaving — never re-open the bubble
  try {
    if (i >= GREETER_LINES.length) {
      depart();
      return;
    }
    let el = g.bubble;
    if (!el) {
      el = document.createElement("div");
      el.setAttribute("aria-hidden", "true");
      // Inline-styled like the canvas (no stylesheet handshake); glass over
      // the blue palette, floating to the LEFT of the balloon. Inert to input
      // — the document-level dismiss handles UX-1 (plain text inside).
      el.style.cssText =
        "position:fixed;right:104px;bottom:9.4rem;max-width:236px;z-index:5;" +
        "pointer-events:none;background:rgba(255,255,255,.92);color:#0a2e5c;" +
        "border:1px solid rgba(13,79,160,.35);border-radius:12px;border-bottom-right-radius:3px;" +
        "padding:.55rem .7rem;font-size:.82rem;line-height:1.4;" +
        "box-shadow:0 6px 22px rgba(4,30,60,.18);";
      document.body.appendChild(el);
      g.bubble = el;
    }
    el.innerHTML = wmHtml(GREETER_LINES[i]); // trusted static script, escaped anyway
    g.timers.push(window.setTimeout(() => speak(i + 1), LINE_MS));
  } catch {
    unmount();
  }
}

/**
 * The one-shot first-visit greeter (idempotent; no-ops outside a browser).
 * Called by app.js ONLY right after the balloon landing intro has actually
 * played (first visit, or the ?anim=1 replay) — never on a routine boot, so
 * returning visitors never see a figure. Swishes in through clouds, delivers
 * the pointer lines, then climbs away and unmounts itself.
 */
export function showBalloonGreeter() {
  if (guide || typeof document === "undefined") return;
  let canvas = null;
  try {
    canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = BOX_W * dpr;
    canvas.height = BOX_H * dpr;
    // Below every overlay/panel (z-index 10+) and inert to input; sits above
    // the composer's right corner. Styled inline so no stylesheet handshake
    // (CSS_VERSION) is involved.
    canvas.style.cssText =
      `position:fixed;right:6px;bottom:7.6rem;width:${BOX_W}px;height:${BOX_H}px;` +
      "z-index:5;pointer-events:none;";
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    document.body.appendChild(canvas);
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches; // inside try — a missing API just means no greeter
    // Any tap/click anywhere sends it on its way early (UX-1: the bubble holds
    // no interactive content, so every outside interaction dismisses — and the
    // pointer-events:none layers let that same tap still reach the app).
    const dismiss = () => depart();
    guide = {
      canvas,
      ctx,
      tasks: 0,
      flareAt: -1e9,
      swish: null,
      rise: 0,
      reduced,
      raf: 0,
      departAt: -1,
      bubble: null,
      timers: [],
      dismiss,
    };
    startSwish("x"); // arrive through the clouds
    guide.raf = requestAnimationFrame(frame);
    guide.timers.push(window.setTimeout(() => speak(0), 900)); // settle, then talk
    document.addEventListener("pointerdown", dismiss, true);
    // A hidden tab stops drawing (frame checks document.hidden); on return the
    // reduced-motion static path may have parked the loop — restart it.
    document.addEventListener("visibilitychange", () => {
      if (guide && !document.hidden) {
        cancelAnimationFrame(guide.raf);
        guide.raf = requestAnimationFrame(frame);
      }
    });
  } catch {
    try {
      canvas?.remove(); // never leave a dead canvas behind
    } catch {}
    guide = null;
  }
}

/** A task completed while the greeter is still on screen: flare the burner,
 * climb a notch, hang a pennant — clouds streak downward with the climb.
 * Fail-soft no-op when unmounted (i.e. on every visit after the first). */
export function balloonTaskDone() {
  const g = guide;
  if (!g) return;
  try {
    g.tasks++;
    g.flareAt = performance.now();
    startSwish("y");
    if (g.reduced) {
      cancelAnimationFrame(g.raf);
      g.raf = requestAnimationFrame(frame); // repaint the static balloon
    }
  } catch {}
}
