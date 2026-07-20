// @ts-check
// The strolling ghost: after the umbrella intro, the little Se/cure ghost
// ambles across the lower part of the page carrying one of the intro's own
// PINK umbrellas over its shoulder — swaying with it, strutting with swagger —
// and pauses now and then to SAY something (a small speech bubble of on-brand,
// privacy-flavoured quips). It's the ambient extension of the first-visit
// umbrella experience: the umbrella was the tier's symbol; here the mascot
// carries it around and shows a bit of personality.
//
// Structured like every DRC module: a PURE core (the stroll planner, the
// facing math, the quip cycle and the click-through message queue — everything
// above `startGhostWalk`) that runs in Node for the unit suite
// (public/js/ghostwalk.test.js), and a DOM layer (one fixed overlay) that only
// ever runs in the browser. No dependencies, no server involvement —
// decoration, like the intro. Nothing downstream awaits it for correctness.
//
// The overlay wrap is pointer-events:none so its empty fixed region never
// blocks the chat, but the ghost body and its speech bubble opt back IN (owner
// directive 2026-07-20): a tap on the ghost freezes the stroll and pages
// through the messages one per tap, and the tap after the last message retires
// it. Everything else on the page stays reachable.
//
// The umbrella it carries is the SAME 3D umbrella as the first-visit intro: it
// reuses the intro's pure geometry (public/cure/umbrella.js) verbatim — the
// gored pink/white canopy, the scalloped rim band, the ribs/rings/edge wire,
// the shaft + crook, and the beaded fringe — frozen in the fully-alive state
// and hung from the ghost's hand, dangling and swaying with the same motion
// range as the intro's bloomed umbrellas. Only the draw driver here is new.

import {
  clamp01,
  PANELS,
  twistOffset,
  scallopFactor,
  project,
  FLEET,
} from "./umbrella.js";

// ---- the pure core -----------------------------------------------------------------

// What the ghost says as it strolls, in order. Kept short (they float above a
// moving character) and squarely on the tier's message: your research runs in
// THIS browser, the server is never in the path. The umbrella lines lean into
// the prop it's carrying.
export const GHOST_QUIPS = [
  "Everything here stays in this browser. Spooky, right?",
  "No server's watching — cross my heart. 👻",
  "Your API key never leaves this tab.",
  "Se/cure by construction. That's the whole trick.",
  "Bring your own key; I'll bring the umbrella. ☂",
  "Rain or shine, your chats stay local.",
  "I don't haunt your data — I shelter it.",
  "Private research, no account. Boo.",
];

/** Cycle the quips forever, tolerant of any integer index (negatives, huge).
 * @param {string[]} quips
 * @param {number} i */
export function pickQuip(quips, i) {
  if (!quips.length) return "";
  const n = quips.length;
  return quips[((Math.trunc(i) % n) + n) % n];
}

/** The click-through message queue (owner directive 2026-07-20). Once the user
 * taps the ghost it stops strolling and becomes a click-to-advance reader: each
 * tap shows the NEXT message in order, walking the full quip list from the top.
 * `clicks` is the running tap count (1 = the first tap → first message). Returns
 * the message to show for that tap, or null once the queue is exhausted — the
 * signal for the DOM layer to retire (the final tap that dismisses it). Unlike
 * `pickQuip` this does NOT wrap: it is a finite queue with a defined end so the
 * ghost always has a last message and then goes away.
 * @param {string[]} quips @param {number} clicks */
export function clickMessage(quips, clicks) {
  const n = quips.length;
  const c = Math.trunc(clicks);
  if (n === 0 || c < 1 || c > n) return null;
  return quips[c - 1];
}

/** Which way the ghost faces walking from `fromX` to `toX`: +1 = rightward
 * (the drawn default), -1 = leftward (mirrored). A zero-length move keeps the
 * rightward default so a degenerate leg never flickers the mirror.
 * @param {number} fromX
 * @param {number} toX */
export function facing(fromX, toX) {
  return toX < fromX ? -1 : 1;
}

// A relaxed amble: pixels of travel per second. Distance sets each leg's
// duration off this, so a long cross takes longer than a short shuffle and the
// pace reads even.
export const STROLL_SPEED = 78;
// Never dawdle below / crawl above these bounds however short/long the leg.
export const LEG_MS_MIN = 1600;
export const LEG_MS_MAX = 6000;

/** Plan a stroll: a sequence of legs across the usable width, each a target x
 * (px, left edge of the ghost box), a travel duration, and whether the ghost
 * speaks on arrival (and which quip). Deterministic given the injected `rand`
 * (defaults to Math.random) so the DOM layer stays dumb and the planning is
 * unit-testable. The ghost starts just off the left edge and every leg moves a
 * real distance (at least `minTravel`) so it always visibly walks.
 * @param {{ vw:number, ghostW:number, legs?:number, margin?:number,
 *   minTravel?:number, rand?:() => number }} opts */
export function planStroll(opts) {
  const vw = Math.max(0, opts.vw || 0);
  const ghostW = Math.max(0, opts.ghostW || 0);
  const legs = Math.max(1, Math.trunc(opts.legs || 5));
  // The default inset is generous on purpose: the ghost only ever SPEAKS at a
  // planned stop, so keeping its stops ≥ this far from each edge means the
  // centered speech bubble (capped near 200px) never clips off-screen, down to
  // a ~360px phone. Callers can still override for a tighter band.
  const margin = opts.margin ?? 72;
  const rand = opts.rand || Math.random;
  // Usable band for the ghost's left edge; clamp so a narrow viewport still
  // yields a valid (possibly tiny) range instead of an inverted one.
  const lo = margin;
  const hi = Math.max(lo, vw - ghostW - margin);
  const span = hi - lo;
  const minTravel = Math.min(opts.minTravel ?? 120, span);

  const out = [];
  // Start off-screen left so it strolls IN.
  let cur = -ghostW;
  let quipIdx = 0;
  for (let i = 0; i < legs; i++) {
    let target = lo + rand() * span;
    // Guarantee a real walk: if the pick landed too close to where we are,
    // push it a full minTravel to the side with more room.
    if (Math.abs(target - cur) < minTravel) {
      const roomRight = hi - cur;
      const roomLeft = cur - lo;
      target = roomRight >= roomLeft ? Math.min(hi, cur + minTravel) : Math.max(lo, cur - minTravel);
    }
    const dist = Math.abs(target - cur);
    const dur = Math.min(LEG_MS_MAX, Math.max(LEG_MS_MIN, (dist / STROLL_SPEED) * 1000));
    // Speak after most legs, but never on the entrance walk-in (i === 0): the
    // first arrival always speaks, the rest do 75% of the time — life without
    // a wall of bubbles.
    const say = i > 0 && (i === 1 || rand() < 0.75);
    out.push({
      x: target,
      face: facing(cur, target),
      dur,
      say,
      quip: say ? pickQuip(GHOST_QUIPS, quipIdx++) : "",
    });
    cur = target;
  }
  return out;
}

// ---- the DOM layer (browser only) --------------------------------------------------

// The ghost (viewBox === render px so hand coords map 1:1). The character only:
// body, face, floaty hem, and one arm raised to a GRIP point up-right where the
// 3D canvas umbrella's shaft foot sits. The umbrella itself is the canvas
// overlay drawn below, so the two layers meet at GRIP.
const GHOST_W = 80;
const GHOST_H = 88;
// The hand/grip, in ghost-SVG (= px) coordinates. The umbrella's shaft foot and
// pendulum pivot land exactly here.
const GRIP_X = 60;
const GRIP_Y = 30;

const GHOST_SVG = `
<svg class="gw-svg" viewBox="0 0 ${GHOST_W} ${GHOST_H}" width="${GHOST_W}" height="${GHOST_H}" aria-hidden="true">
  <!-- the ghost: rounded top, scalloped floaty hem -->
  <path class="gw-ghost" d="M14 84 a26 26 0 0 1 -4 -16 v-8 a26 26 0 0 1 52 0 v8
           q0 6 -3 11 l-5 -5 -5 6 -5 -6 -5 6 -5 -6 -5 5 q-4 -5 -5 -1 z"
        fill="#ffffff" fill-opacity=".97" stroke="#3d3418" stroke-width="2.4" stroke-linejoin="round"/>
  <circle cx="26" cy="52" r="2.8" fill="#3d3418"/>
  <circle cx="40" cy="52" r="2.8" fill="#3d3418"/>
  <path d="M28 60 q5 4 10 0" fill="none" stroke="#3d3418" stroke-width="2" stroke-linecap="round"/>
  <!-- cheek blush, matching the umbrella's rose -->
  <circle cx="20" cy="58" r="2.2" fill="#df6e8e" fill-opacity=".5"/>
  <circle cx="46" cy="58" r="2.2" fill="#df6e8e" fill-opacity=".5"/>
  <!-- the raised arm reaching up to the umbrella grip (GRIP_X, GRIP_Y) -->
  <path d="M50 60 q10 -6 10 -30" fill="none" stroke="#3d3418" stroke-width="2.4" stroke-linecap="round"/>
  <!-- a little mitt at the grip -->
  <circle cx="${GRIP_X}" cy="${GRIP_Y}" r="3" fill="#ffffff" stroke="#3d3418" stroke-width="2"/>
</svg>`;

// ---- the 3D umbrella (canvas; reuses the intro's geometry) --------------------------

// The umbrella canvas is taller than the ghost — the canopy rises well above
// the head — and its bottom-center is the grip/pivot.
const UMB_W = 52;
const UMB_H = 62;
// A fixed 3/4 hanging view (0 = straight down, π/2 = side): enough pitch to read
// as a 3D canopy with the shaft hanging, not a flat disc.
const UMB_CAM = 1.16;
const UMB_CREAM = "#fff4f8"; // fringe tassels
const UMB_HANDLE = "#9c6472"; // shaft + crook, dusty rose

/** Draw ONE fully-alive umbrella (the intro's bloomed state) onto ctx, its
 * canopy centered high and its shaft dropping to the bottom-center GRIP. Time
 * `now` (ms) and the integrated `spin` drive the canopy's own 3D sway, lazy
 * twirl and beaded-fringe swing — the same life the intro umbrellas have; the
 * gross pendulum "dangle from the hand" is a CSS transform on the canvas.
 * @param {CanvasRenderingContext2D} ctx
 * @param {typeof FLEET[number]} style
 * @param {number} now @param {number} spin */
function drawAliveUmbrella(ctx, style, now, spin) {
  ctx.clearRect(0, 0, UMB_W, UMB_H);
  const cx = UMB_W / 2;
  const cy = UMB_H * 0.34; // the rim plane's screen center; shaft drops below
  const R = UMB_W * 0.42;
  const domeFrac = style.dome;
  const sc = style.scallop;
  const pg = clamp01(style.pagoda);
  const panelA = (2 * Math.PI) / PANELS;
  const domeH = domeFrac * R;
  /** @param {number} r */
  const domeZ = (r) => domeH * ((1 - pg) * (1 - r * r) + pg * (1 - r) * (1 - r));

  // A gentle, continuous canopy sway (the intro's own rx/ry nod).
  const rx = 0.12 * Math.sin(now * 0.0011 + style.phase);
  const ry = 0.09 * Math.cos(now * 0.0009 + style.phase * 1.4);
  const f = {
    cosRX: Math.cos(rx),
    sinRX: Math.sin(rx),
    cosRY: Math.cos(ry),
    sinRY: Math.sin(ry),
    cam: UMB_CAM,
  };
  /** canopy point → sway → camera projection → screen px
   * @param {{x:number,y:number,z:number}} p */
  const toScreen = (p) => {
    const y1 = p.y * f.cosRX - p.z * f.sinRX;
    const z1 = p.y * f.sinRX + p.z * f.cosRX;
    const x1 = p.x * f.cosRY + z1 * f.sinRY;
    const z2 = -p.x * f.sinRY + z1 * f.cosRY;
    const pr = project({ x: x1, y: y1, z: z2 }, f.cam);
    return { x: cx + pr.x, y: cy + pr.y };
  };
  /** @param {number} rFrac @param {number} theta @param {number} [edgeF] */
  const pt = (rFrac, theta, edgeF) => {
    const a = theta + twistOffset(rFrac, 0) + spin;
    const r = rFrac * R * (edgeF ?? 1);
    return toScreen({ x: r * Math.cos(a), y: r * Math.sin(a), z: domeZ(rFrac) });
  };

  // -- shaft: from the canopy apex straight down to the GRIP (bottom-center) --
  const axisScreenY = (/** @type {number} */ z) => cy - z * Math.sin(UMB_CAM);
  const apexY = axisScreenY(domeH);
  ctx.strokeStyle = UMB_HANDLE;
  ctx.lineWidth = Math.max(1.4, R * 0.05);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(cx, apexY);
  ctx.lineTo(cx, UMB_H - 1); // the foot === the grip
  ctx.stroke();
  // the little crook at the foot
  ctx.beginPath();
  ctx.moveTo(cx, UMB_H - 1);
  ctx.quadraticCurveTo(cx + R * 0.16, UMB_H - 1, cx + R * 0.16, UMB_H - R * 0.14);
  ctx.stroke();

  // -- gore fill: alternating pink / white panels -----------------------------
  for (let i = 0; i < PANELS; i++) {
    const a0 = i * panelA;
    const a1 = a0 + panelA;
    ctx.beginPath();
    const c = pt(0, a0);
    ctx.moveTo(c.x, c.y);
    for (let k = 1; k <= 6; k++) ctx.lineTo(pt(k / 6, a0).x, pt(k / 6, a0).y);
    for (let k = 0; k <= 8; k++) {
      const fr = k / 8;
      const p = pt(1, a0 + fr * panelA, scallopFactor(fr, 1, sc));
      ctx.lineTo(p.x, p.y);
    }
    for (let k = 6; k >= 0; k--) ctx.lineTo(pt(k / 6, a1).x, pt(k / 6, a1).y);
    ctx.closePath();
    ctx.fillStyle = i % 2 ? style.alt : style.col;
    ctx.fill();
  }

  // -- the thick contrasting rim band (rFrac 0.72 → scalloped edge) ------------
  const seg = PANELS * 12;
  ctx.fillStyle = style.border;
  ctx.beginPath();
  for (let k = 0; k <= seg; k++) {
    const ang = (k / seg) * 2 * Math.PI;
    const fr = (ang / panelA) % 1;
    const p = pt(1, ang, scallopFactor(fr, 1, sc));
    if (k === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  }
  for (let k = seg; k >= 0; k--) {
    const p = pt(0.72, (k / seg) * 2 * Math.PI);
    ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();
  ctx.fill();

  // -- wire contours: ribs, two rings, the scalloped edge ---------------------
  ctx.strokeStyle = style.border;
  ctx.lineWidth = Math.max(0.8, R * 0.03);
  ctx.lineJoin = "round";
  for (let i = 0; i < PANELS; i++) {
    const a0 = i * panelA;
    ctx.beginPath();
    const c = pt(0, a0);
    ctx.moveTo(c.x, c.y);
    for (let k = 1; k <= 10; k++) ctx.lineTo(pt(k / 10, a0).x, pt(k / 10, a0).y);
    ctx.stroke();
  }
  for (const ringR of [0.42, 0.72]) {
    ctx.beginPath();
    const p0 = pt(ringR, 0);
    ctx.moveTo(p0.x, p0.y);
    for (let k = 1; k <= 44; k++) ctx.lineTo(pt(ringR, (k / 44) * 2 * Math.PI).x, pt(ringR, (k / 44) * 2 * Math.PI).y);
    ctx.stroke();
  }
  ctx.beginPath();
  const e0 = pt(1, 0, scallopFactor(0, 1, sc));
  ctx.moveTo(e0.x, e0.y);
  for (let k = 1; k <= PANELS * 8; k++) {
    const panel = Math.floor((k - 1) / 8);
    const fr = (k - panel * 8) / 8;
    const p = pt(1, (panel + fr) * panelA, scallopFactor(fr, 1, sc));
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();

  // -- the dangling beaded fringe (swings on its own rhythm) -------------------
  const strandsPerPanel = 3;
  const len = 0.2 * R;
  ctx.lineCap = "round";
  ctx.strokeStyle = style.border;
  ctx.lineWidth = Math.max(0.7, R * 0.016);
  const tasselR = Math.max(0.9, R * 0.03);
  for (let i = 0; i < PANELS; i++) {
    for (let j = 0; j < strandsPerPanel; j++) {
      const fr = (j + 0.5) / strandsPerPanel;
      const a = (i + fr) * panelA + spin;
      const rr = R * scallopFactor(fr, 1, sc);
      const bx = rr * Math.cos(a);
      const by = rr * Math.sin(a);
      const swing = 0.45 * Math.sin(now * 0.004 + a * 2.6 + style.phase);
      const tx = -Math.sin(a);
      const ty = Math.cos(a);
      const rim = toScreen({ x: bx, y: by, z: 0 });
      const mid = toScreen({ x: bx + swing * len * 0.5 * tx, y: by + swing * len * 0.5 * ty, z: -len * 0.5 });
      const tip = toScreen({ x: bx + swing * len * tx, y: by + swing * len * ty, z: -len });
      ctx.beginPath();
      ctx.moveTo(rim.x, rim.y);
      ctx.quadraticCurveTo(mid.x, mid.y, tip.x, tip.y);
      ctx.stroke();
      ctx.fillStyle = UMB_CREAM;
      ctx.beginPath();
      ctx.arc(tip.x, tip.y, tasselR, 0, 2 * Math.PI);
      ctx.fill();
    }
  }
}

let running = false;

/** Start the ambient stroll. Fully self-contained: builds its own overlay,
 * runs a few legs, then fades out and cleans up. No-op if one is already
 * running, if there's no viewport, or under prefers-reduced-motion (unless
 * `force`, the ?anim=1 replay path, overrides it — mirroring the intro gate).
 * @param {{ force?: boolean }} [opts] */
export function startGhostWalk(opts = {}) {
  if (running) return;
  if (typeof document === "undefined" || typeof window === "undefined") return;
  let reduced = false;
  try {
    reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    // no matchMedia — animate
  }
  if (reduced && !opts.force) return;

  const vw = window.innerWidth || document.documentElement.clientWidth || 0;
  if (vw < 220) return; // too cramped to stroll nicely
  const ghostW = GHOST_W;

  running = true;

  const wrap = document.createElement("div");
  wrap.id = "ghostwalk";
  wrap.setAttribute("aria-hidden", "true");
  const say = document.createElement("div");
  say.className = "gw-say";
  const inner = document.createElement("div");
  inner.className = "gw-inner";
  // The stage carries the strut (swagger); the ghost SVG and the umbrella
  // canvas both live inside it so they bob together, and the umbrella swings
  // (dangles) about the grip via its own transform on top.
  const stage = document.createElement("div");
  stage.className = "gw-stage";
  stage.innerHTML = GHOST_SVG;
  inner.appendChild(stage);
  wrap.appendChild(say);
  wrap.appendChild(inner);
  document.body.appendChild(wrap);

  // The 3D umbrella: a canvas hung from the grip, pendulum-swinging on top of
  // the strut. Best-effort — if a 2D context isn't available the ghost simply
  // strolls empty-handed (never a hard failure).
  let umbRaf = 0;
  try {
    const canvas = document.createElement("canvas");
    canvas.className = "gw-umbrella-canvas";
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.left = GRIP_X - UMB_W / 2 + "px";
    canvas.style.top = GRIP_Y - UMB_H + "px";
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.style.width = UMB_W + "px";
      canvas.style.height = UMB_H + "px";
      canvas.width = Math.round(UMB_W * dpr);
      canvas.height = Math.round(UMB_H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      stage.appendChild(canvas);
      const style = FLEET[0]; // deep rose, white rim — unmistakably pink
      let spin = 0;
      let last = 0;
      const draw = (/** @type {number} */ now) => {
        if (!canvas.isConnected) return; // torn down with the wrap
        if (last) spin += 0.00028 * style.dir * (now - last); // a lazy twirl
        last = now;
        drawAliveUmbrella(ctx, style, now, spin);
        umbRaf = requestAnimationFrame(draw);
      };
      umbRaf = requestAnimationFrame(draw);
    }
  } catch {
    // no umbrella — the stroll still runs
  }

  const legs = planStroll({ vw, ghostW });
  // Enter off-screen left.
  wrap.style.transform = `translateX(${-ghostW}px)`;

  let i = 0;
  let sayTimer = 0;
  let doneTimer = 0;
  let legTimer = 0;
  // Interaction state (owner directive 2026-07-20): the first tap on the ghost
  // freezes the stroll and hands control to a click-through message reader.
  let interactive = false;
  let retiring = false;
  let clicks = 0;

  /** @param {number} face */
  function setFacing(face) {
    // The inner element (the SVG only) carries the mirror, so the wrap's
    // translateX stays a clean coordinate and the speech bubble — a sibling of
    // `inner`, not a child — is never mirrored and stays readable both ways.
    inner.style.transform = face < 0 ? "scaleX(-1)" : "scaleX(1)";
  }

  /** @param {string} text @param {boolean} [sticky] */
  function speak(text, sticky) {
    say.textContent = text;
    say.classList.add("show");
    clearTimeout(sayTimer);
    // Ambient legs auto-hide the bubble; a click-driven message holds until the
    // next tap so the user can read at their own pace.
    if (!sticky) sayTimer = window.setTimeout(() => say.classList.remove("show"), 2600);
  }

  function retire() {
    clearTimeout(sayTimer);
    clearTimeout(doneTimer);
    clearTimeout(legTimer);
    wrap.classList.add("bye");
    window.setTimeout(() => {
      if (umbRaf) cancelAnimationFrame(umbRaf);
      wrap.remove();
      running = false;
    }, 700);
  }

  // Halt the current stroll leg in place: pin the wrap to its live on-screen x
  // (read from the computed transform mid-glide) with a zero-duration
  // transition so it stops cleanly instead of coasting to the leg's target.
  function freezeStroll() {
    clearTimeout(doneTimer);
    clearTimeout(legTimer);
    let x = 0;
    try {
      const t = window.getComputedStyle(wrap).transform;
      if (t && t !== "none") x = new DOMMatrixReadOnly(t).m41;
    } catch {
      // no computed matrix — fall back to leaving the current transform as-is
      return;
    }
    wrap.style.transitionDuration = "0ms";
    wrap.style.transform = `translateX(${x}px)`;
  }

  // A tap on the ghost: the first one freezes the stroll; every tap then shows
  // the next queued message, and the tap AFTER the last message retires it.
  function onGhostClick() {
    if (retiring) return;
    if (!interactive) {
      interactive = true;
      freezeStroll();
    }
    clicks++;
    const msg = clickMessage(GHOST_QUIPS, clicks);
    if (msg == null) {
      retiring = true;
      retire();
      return;
    }
    speak(msg, true);
  }
  wrap.addEventListener("click", onGhostClick);

  function nextLeg() {
    // Once the user has taken over (or we're leaving), the ambient stroll stops
    // scheduling itself — clicks drive everything from here.
    if (interactive || retiring) return;
    if (i >= legs.length) {
      retire();
      return;
    }
    const leg = legs[i++];
    setFacing(leg.face);
    // Walking hides the bubble; it returns on arrival if this leg speaks.
    say.classList.remove("show");
    wrap.style.transitionDuration = leg.dur + "ms";

    let advanced = false;
    const onArrive = () => {
      if (advanced || interactive || retiring) return;
      advanced = true;
      wrap.removeEventListener("transitionend", onTransEnd);
      if (leg.say) {
        speak(leg.quip);
        legTimer = window.setTimeout(nextLeg, 2900); // linger while it talks
      } else {
        legTimer = window.setTimeout(nextLeg, 500);
      }
    };
    /** @param {TransitionEvent} e */
    const onTransEnd = (e) => {
      if (e.propertyName === "transform") onArrive();
    };
    wrap.addEventListener("transitionend", onTransEnd);
    // Safety: transitionend can be swallowed (bfcache, tab switch).
    doneTimer = window.setTimeout(onArrive, leg.dur + 400);

    // Two frames so the prior transform commits before the new target lands,
    // otherwise the very first leg has no travel (same trick the intro uses).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        wrap.style.transform = `translateX(${leg.x}px)`;
      });
    });
  }

  // Small beat before it walks in, so it doesn't collide with the intro's
  // final frame.
  window.setTimeout(nextLeg, 450);
}
