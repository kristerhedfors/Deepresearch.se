// @ts-check
// The DRC first-visit intro animation: the logotype's Swedish-flag vortex
// (blue disc, twisted yellow arms) — a fleet of them, spinning at different
// sizes — untwists into umbrella canopies, gets its contours drawn and its
// color removed until only a wire drawing remains. The camera then swings a
// quarter circle down from the top view while the now-3D wireframe umbrellas
// hang in the sky — and THEN they turn to life: soft color floods back into
// each canopy in a WHITE-AND-PINK palette (every umbrella its own shade), the
// crowd deliberately varied in SHAPE (flat domes, tall pagodas, shallow or
// deeply frilled edges), each finished with a THICK DECORATED BORDER ringing
// the rim — a contrasting band studded with picot beads — and beaded fringe
// that unspools and dangles, swaying, from the scalloped edge. The umbrella
// is the tier's own symbol: DRC is the sheltered, all-client-side side of
// the site.
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

// The whole scene runs 2.5× the originally-designed pace (2026-07-12
// directive: the first cut was "a little bit slow"), scaled further by the
// admin's site-config `anim_speed` slider (served publicly at GET
// /api/anim; slider center = 1 = exactly this default). Speed scales the
// CLOCK, not the marks — T below stays the designed shape, and everything
// (phases, spin, sway, sink) hastens uniformly.
export const BASE_SPEED = 2.5;

/** The admin multiplier, defensively: garbage in → the default 1; honest
 * values clamp to [0.25, 4] (the same clamp src/config.js enforces).
 * @param {unknown} v */
export function clampAnimMult(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(4, Math.max(0.25, n));
}

// The reverse-playback EASTER EGG: once every EASTER_EGG_EVERY times the intro
// plays, it runs the WHOLE timeline backwards (bloomed umbrellas rewind down to
// the logo vortex) instead of forwards. A counter in localStorage
// (`dr_intro_plays`) drives it; this pure predicate is the trigger, split out
// so it's Node-tested. NOTE this is the /cure INTRO only — the loading-symbol
// spinners always boomerang (forward-then-back), a separate behavior.
export const EASTER_EGG_EVERY = 40;
/** @param {number} playCount */
export function easterEggReverse(playCount) {
  return Number.isInteger(playCount) && playCount > 0 && playCount % EASTER_EGG_EVERY === 0;
}

// Phase boundaries in ms of DESIGN time (divide by BASE_SPEED × multiplier
// for wall-clock). One shared clock; every visual parameter below is
// a ramp between two of these marks, so the phases overlap smoothly instead
// of cutting: swirl → untwist → contours drawn while logo color drains → the
// quarter-circle camera drop → the Victorian revival (color floods back,
// each umbrella its own hue) → fringe dangles in → fade.
//
// Kept deliberately tight (T.end < 15000): at the 2.5× base pace the whole
// scene still lands under 6 s of real time (asserted in the unit suite).
export const T = {
  swirlEnd: 2800, // pure logo-vortex spinning & pulsing until here
  untwistEnd: 4900, // arms straighten: vortex → umbrella top view
  wireEnd: 6600, // contours fully drawn
  fillGone: 7500, // logo color fully removed — wire only
  tiltStart: 7500, // camera starts the quarter circle…
  tiltEnd: 10600, // …and is level with the umbrellas here
  reviveStart: 9600, // Victorian color floods back (overlaps the late tilt)…
  reviveEnd: 12400, // …each canopy fully, richly, differently colored
  decoStart: 11000, // beaded fringe unspools from the rims…
  decoEnd: 13200, // …fully hung and swaying
  fadeStart: 13500, // a beat to live, then out
  end: 14700,
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
 *           revive:number, deco:number, cam:number, camP:number,
 *           shaft:number, spinRate:number, pulse:number, fade:number,
 *           done:boolean}}
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
    // Logo panel color; starts draining once the contours are half drawn,
    // gone entirely by fillGone — monotone down, it never returns (the
    // REVIVAL is its own colors, on `revive` below).
    fill: 1 - ramp(t, (T.untwistEnd + T.wireEnd) / 2, T.fillGone),
    // The Victorian revival: rich per-umbrella color flooding into the
    // finished wireframe. 0 through the whole build-up, 1 once fully alive.
    revive: ramp(t, T.reviveStart, T.reviveEnd),
    // Dangling beaded fringe: unspools last, "the decorations in the end".
    deco: ramp(t, T.decoStart, T.decoEnd),
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

// A deep, pointed scallop between every rib — the pronounced Victorian
// canopy edge the fringe hangs from (the vortex/logo phase eases into it via
// the growing `scallop` ramp, so the swirl still starts as a clean disc).
export const SCALLOP_DEPTH = 0.15;
// Canopy dome height as a fraction of radius: tall and domed, a Victorian
// pagoda silhouette rather than a flat beach parasol.
export const DOME_FRAC = 0.46;

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
// and directions ("a bunch of them, in different sizes"). fx/fy are viewport
// fractions of the top-view scatter; zLift is how high each one hangs in the
// sky once the camera drops (fraction of the viewport height); delay staggers
// their appearance at the start. The revival dresses each one in a
// WHITE-AND-PINK scheme — `col` is its canopy, `alt` the alternating gore,
// `border` the contrasting rim band (all kept in the pink/white family so the
// crowd stays on-palette) — a distinct SHAPE (`dome` is the canopy height as a
// fraction of radius, `pagoda` blends a rounded dome (0) toward a pointed
// pagoda (1), `scallop` is how deeply its edge frills), and — appearing as it
// regains color from the wireframe — its own DECORATIONS: `motif` is the
// pattern across the canopy (dots/rings/scales/chevron/stars) and `edge` is
// the thick trim style hung along the rim (beads/scallops/points/swags).
export const EDGE_STYLES = ["beads", "scallops", "points", "swags"];
export const MOTIFS = ["dots", "rings", "scales", "chevron", "stars"];
export const FLEET = [
  { fx: 0.30, fy: 0.34, s: 0.335, speed: 1.0, dir: 1, phase: 0.0, zLift: 0.55, delay: 0,
    col: "#e06c8c", alt: "#f3aec1", border: "#fff2f6", dome: 0.50, pagoda: 0.15, scallop: 0.20,
    motif: "dots", edge: "scallops" }, // deep rose, white rim
  { fx: 0.72, fy: 0.24, s: 0.215, speed: 1.35, dir: -1, phase: 1.7, zLift: 0.95, delay: 260,
    col: "#fff8fb", alt: "#f6bfd0", border: "#e5789a", dome: 0.34, pagoda: 0.00, scallop: 0.10,
    motif: "rings", edge: "beads" }, // white, flat dome
  { fx: 0.55, fy: 0.64, s: 0.42, speed: 0.8, dir: 1, phase: 3.1, zLift: 0.18, delay: 520,
    col: "#f7c6d6", alt: "#ffffff", border: "#d15c7e", dome: 0.58, pagoda: 0.55, scallop: 0.16,
    motif: "scales", edge: "points" }, // blush, tall pagoda
  { fx: 0.15, fy: 0.74, s: 0.175, speed: 1.6, dir: -1, phase: 4.2, zLift: 1.25, delay: 780,
    col: "#ea9bb2", alt: "#fde4ec", border: "#ffffff", dome: 0.44, pagoda: 0.30, scallop: 0.24,
    motif: "chevron", edge: "swags" }, // rose, deeply frilled
  { fx: 0.87, fy: 0.68, s: 0.26, speed: 1.15, dir: 1, phase: 2.3, zLift: 0.75, delay: 1040,
    col: "#f4b8c8", alt: "#fff9fc", border: "#df6e8e", dome: 0.40, pagoda: 0.70, scallop: 0.13,
    motif: "stars", edge: "scallops" }, // pale pink, pointed
  { fx: 0.43, fy: 0.11, s: 0.145, speed: 1.8, dir: -1, phase: 5.0, zLift: 1.6, delay: 1300,
    col: "#ffffff", alt: "#efa8bd", border: "#e56d94", dome: 0.38, pagoda: 0.10, scallop: 0.18,
    motif: "dots", edge: "points" }, // white, pink rim
];

// ---- the DOM layer (browser only) --------------------------------------------------

const YELLOW = "#f5c518"; // the logotype's golden swirl
const BLUE = "#1a56b0"; // the logotype's flag-blue field
const INK = "#3d3418"; // drc.css --text: the wire drawing's ink
const KHAKI = "#c3b091"; // drc.css --bg
const CREAM = "#fff4f8"; // the picot beads & fringe tassels of the revived rim
const HANDLE = "#9c6472"; // the handle's dusty-rose shaft, once alive (on-palette)

/** "#rrggbb" → [r,g,b]. Exported: the one copy the sibling animation modules
 * (umbrella-spinner.js, balloon-intro.js) share. @param {string} c */
export function hex(c) {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
/** @param {number[]} a */
const rgb = (a) => `rgb(${a[0] | 0},${a[1] | 0},${a[2] | 0})`;
/** Linear blend c1→c2 by t∈[0,1]. @param {string} c1 @param {string} c2 @param {number} t
 * Exported for the umbrella SPINNER sibling (public/js/umbrella-spinner.js),
 * which had carried a byte-identical copy — same hex() from this module. */
export function lerpCol(c1, c2, t) {
  const a = hex(c1),
    b = hex(c2);
  return rgb([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
}
/** Rough perceived lightness 0..255. @param {string} c */
function lum(c) {
  const [r, g, b] = hex(c);
  return 0.3 * r + 0.59 * g + 0.11 * b;
}
/** A decoration color that reads on a given canopy: cream on a deep canopy,
 * the canopy's own deeper trim on a pale/white one. @param {{col:string,border:string}} u */
const decoInk = (u) => (lum(u.col) > 210 ? u.border : CREAM);

let playing = false;

/** Resolve whether THIS play runs backwards. An explicit `opts.reverse`
 * boolean wins (the `?anim=rev` verification path) and leaves the counter
 * untouched; otherwise bump the persistent play counter and fire the egg on
 * every EASTER_EGG_EVERY-th play. Fail-soft: storage blocked → forwards.
 * @param {{ reverse?: boolean }} opts */
function resolveReverse(opts) {
  if (typeof opts.reverse === "boolean") return opts.reverse;
  try {
    const KEY = "dr_intro_plays";
    const n = (parseInt(localStorage.getItem(KEY) || "0", 10) || 0) + 1;
    localStorage.setItem(KEY, String(n));
    return easterEggReverse(n);
  } catch {
    return false;
  }
}

/**
 * Plays the intro once over the whole viewport. Resolves the caller via
 * onDone when finished or skipped (tap anywhere). Never throws into the
 * caller — animation failure must not cost a chat. `speed` is the admin
 * multiplier from /api/anim (1 = default; the 2.5× BASE_SPEED is applied
 * here on top of it). `reverse` forces the direction (else the easter-egg
 * counter decides): a REVERSE play rewinds the whole timeline — bloomed
 * umbrellas fold back down into the spinning logo vortex.
 * @param {{ onDone?: () => void, speed?: number, reverse?: boolean }} [opts]
 */
export function playUmbrellaIntro(opts = {}) {
  const onDone = opts.onDone || (() => {});
  const clockRate = BASE_SPEED * clampAnimMult(opts.speed);
  if (playing || typeof document === "undefined") {
    onDone();
    return;
  }
  playing = true;
  // Once every 40 plays the whole intro runs backwards (easter egg).
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

  // Per-umbrella mutable state: accumulated spin angle (integrated so the
  // spin-rate ramp slows the turn without any angle jump).
  const fleet = FLEET.map((u) => ({ ...u, spin: u.phase * 1.3 }));

  const start = performance.now();
  let last = start;
  let raf = 0;
  let finished = false;

  // First tap stops and REMOVES the animation immediately — no fade-out to
  // wait through, nothing left in the way of the page underneath.
  canvas.addEventListener("pointerdown", cleanup);

  // Wall-clock safety net. The intro is DECORATION drawn on a fixed,
  // full-viewport canvas (z-index 30) that sits on top of the whole app, and
  // it ends by removing that canvas from INSIDE the requestAnimationFrame
  // loop. But RAF is not guaranteed to keep firing: on iOS Safari, right after
  // a same-window navigation, the loop can fire ONCE and then stall — freezing
  // the very first frame (a bare khaki field, before any umbrella has reached
  // its appear-in delay) on top of the page and swallowing every tap
  // underneath, so the app looks like "a full page of khaki, nothing happens"
  // and no button works. A setTimeout is not subject to that RAF stall, so it
  // force-finishes the intro if the RAF clock never reaches the end. Because
  // `prog` is wall-clock driven, a correctly-running intro ALWAYS ends by
  // T.end / clockRate regardless of device speed (a slow device just drops
  // frames, it doesn't run longer); the margin only covers scheduling jitter.
  const maxWall = T.end / clockRate + 1500;
  let watchdog = setTimeout(cleanup, maxWall);

  // Idempotent: the watchdog, a tap, an in-frame error, and the normal end can
  // all race to finish — only the first one does the teardown (and calls
  // onDone once).
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
    // The whole frame is wrapped so a single draw error on some device can't
    // kill the RAF loop and strand the full-screen canvas over the app
    // (same failure mode the watchdog guards): any throw tears the intro down
    // cleanly and reveals the page underneath. Decoration must never break it.
    try {
      return drawFrame(now);
    } catch {
      return cleanup();
    }
  }

  /** @param {number} now */
  function drawFrame(now) {
    if (!ctx) return cleanup();
    // Design-time clock: real elapsed ms × the speed (BASE_SPEED × the
    // admin multiplier). `prog` is the one-way playback progress; on a REVERSE
    // play the timeline t counts DOWN from the end, so the whole thing rewinds.
    // dt (spin integration) carries the reverse sign, so the spin unwinds too.
    const prog = (now - start) * clockRate;
    if (prog >= T.end) return cleanup();
    const dt = Math.min(50, now - last) * clockRate * (reverse ? -1 : 1);
    last = now;
    const t = reverse ? T.end - prog : prog;
    const P = paramsAt(t);

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
      // Per-umbrella shape: canopy height, edge frill depth, and how far the
      // profile leans from a rounded dome toward a pointed pagoda.
      const domeH = (u.dome ?? DOME_FRAC) * R;
      const sc = u.scallop ?? SCALLOP_DEPTH;
      const pg = clamp01(u.pagoda ?? 0);
      // Blended dome height at radius r: rounded (1-r²) ↔ pointed (1-r)²;
      // apex = domeH at r=0, rim = 0 at r=1 for both, so the fringe still
      // hangs from z=0 whatever the shape.
      const domeZ = (/** @type {number} */ r) =>
        domeH * ((1 - pg) * (1 - r * r) + pg * (1 - r) * (1 - r));
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
          { x: r * Math.cos(a), y: r * Math.sin(a), z: domeZ(rFrac) },
          f
        );
      };

      const panelA = (2 * Math.PI) / PANELS;

      // -- the gore fill: logo colors, then (post-revival) Victorian ones --
      // One panel outline builder, shared by both color regimes so the
      // scalloped edge stays identical between them.
      /** @param {number} alpha @param {(i:number)=>string} colorOf */
      const fillPanels = (alpha, colorOf) => {
        ctx.globalAlpha = alpha;
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
            const p = pt(1, a0 + fr * panelA, scallopFactor(fr, P.scallop, sc));
            ctx.lineTo(p.x, p.y);
          }
          for (let k = 8; k >= 0; k--) {
            const p = pt(k / 8, a1);
            ctx.lineTo(p.x, p.y);
          }
          ctx.closePath();
          ctx.fillStyle = colorOf(i);
          ctx.fill();
        }
      };

      if (P.fill > 0.01) {
        // The vortex / beach-umbrella logo top: flag blue + golden swirl.
        fillPanels(P.fill * appear, (i) => (i % 2 ? BLUE : YELLOW));
      }
      if (P.revive > 0.01) {
        const rv = smooth(P.revive) * appear;
        // Alive: this umbrella's own pink/white canopy, gored two-tone.
        fillPanels(rv, (i) => (i % 2 ? u.alt : u.col));

        const ink = decoInk(u); // a mark color that reads on this canopy
        // An accent that reads on the border BAND (cream on a pink band, a
        // pink on a white band) for the rim trim below.
        const accent = lum(u.border) > 210 ? "#e07a99" : CREAM;

        // -- the canopy's own DECORATION, revealed as it regains color ------
        // One motif per umbrella (dots/rings/scales/chevron/stars), so the
        // crowd's tops are all different.
        ctx.globalAlpha = rv;
        ctx.fillStyle = ink;
        ctx.strokeStyle = ink;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        const motif = u.motif || "dots";
        if (motif === "dots") {
          for (const [ring, n, dr] of [[0.34, 8, 0.021], [0.56, 12, 0.021], [0.78, 16, 0.018]]) {
            for (let k = 0; k < n; k++) {
              const p = pt(ring, (k / n) * 2 * Math.PI + ring * 5);
              ctx.beginPath();
              ctx.arc(p.x, p.y, Math.max(1, R * dr), 0, 2 * Math.PI);
              ctx.fill();
            }
          }
        } else if (motif === "rings") {
          ctx.lineWidth = Math.max(1.4, R * 0.03);
          for (const ring of [0.42, 0.66]) {
            ctx.beginPath();
            for (let k = 0; k <= 60; k++) {
              const p = pt(ring, (k / 60) * 2 * Math.PI);
              if (k === 0) ctx.moveTo(p.x, p.y);
              else ctx.lineTo(p.x, p.y);
            }
            ctx.stroke();
          }
        } else if (motif === "scales") {
          ctx.lineWidth = Math.max(1, R * 0.012);
          for (const ring of [0.4, 0.6, 0.8]) {
            const n = Math.round(ring * 22);
            for (let k = 0; k < n; k++) {
              const a = (k / n) * 2 * Math.PI + ring * 7;
              const c0 = pt(ring, a - Math.PI / n);
              const top = pt(ring - 0.07, a);
              const c1 = pt(ring, a + Math.PI / n);
              ctx.beginPath();
              ctx.moveTo(c0.x, c0.y);
              ctx.quadraticCurveTo(top.x, top.y, c1.x, c1.y);
              ctx.stroke();
            }
          }
        } else if (motif === "chevron") {
          ctx.lineWidth = Math.max(1.2, R * 0.016);
          for (let i = 0; i < PANELS; i++) {
            const mid = i * panelA + panelA / 2;
            for (const ring of [0.4, 0.62]) {
              const l = pt(ring, mid - panelA * 0.32);
              const apex = pt(ring - 0.09, mid);
              const rr = pt(ring, mid + panelA * 0.32);
              ctx.beginPath();
              ctx.moveTo(l.x, l.y);
              ctx.lineTo(apex.x, apex.y);
              ctx.lineTo(rr.x, rr.y);
              ctx.stroke();
            }
          }
        } else {
          // stars — little 3-armed asterisks scattered in two rings
          ctx.lineWidth = Math.max(1, R * 0.013);
          for (const [ring, n] of [[0.4, 6], [0.66, 10]]) {
            for (let k = 0; k < n; k++) {
              const c = pt(ring, (k / n) * 2 * Math.PI + ring * 3);
              const s = R * 0.035;
              for (let arm = 0; arm < 3; arm++) {
                const aa = (arm / 3) * Math.PI;
                ctx.beginPath();
                ctx.moveTo(c.x - Math.cos(aa) * s, c.y - Math.sin(aa) * s);
                ctx.lineTo(c.x + Math.cos(aa) * s, c.y + Math.sin(aa) * s);
                ctx.stroke();
              }
            }
          }
        }

        // -- the THICK decorated border band + its varying rim trim --------
        // A wide contrasting band from rFrac 0.74 out to the scalloped edge…
        const seg = PANELS * 16;
        ctx.globalAlpha = rv;
        ctx.fillStyle = u.border;
        ctx.beginPath();
        for (let k = 0; k <= seg; k++) {
          const ang = (k / seg) * 2 * Math.PI;
          const frac = (ang / panelA) % 1;
          const p = pt(1, ang, scallopFactor(frac, P.scallop, sc));
          if (k === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        }
        for (let k = seg; k >= 0; k--) {
          const ang = (k / seg) * 2 * Math.PI;
          const p = pt(0.74, ang);
          ctx.lineTo(p.x, p.y);
        }
        ctx.closePath();
        ctx.fill();

        // …then a trim hung along the very rim, its style varying per
        // umbrella (only once it reads in the tilted 3D view).
        if (P.shaft > 0.12) {
          // A screen point at the scalloped rim for `ang`, dropped `dz` (world
          // units) below it — the trim hangs just under the hem.
          const rimPt = (/** @type {number} */ ang, /** @type {number} */ dz) => {
            const frac = (((ang / panelA) % 1) + 1) % 1;
            const rr = R * scallopFactor(frac, P.scallop, sc);
            const a = ang + u.spin;
            return toScreen({ x: rr * Math.cos(a), y: rr * Math.sin(a), z: -dz }, f);
          };
          const N = PANELS * 4;
          const drop = 0.075 * R;
          const beadR = Math.max(1.4, R * 0.022);
          const style = u.edge || "beads";
          if (style === "beads") {
            ctx.fillStyle = accent;
            for (let k = 0; k < N; k++) {
              const p = rimPt((k / N) * 2 * Math.PI, drop * 0.7);
              ctx.beginPath();
              ctx.arc(p.x, p.y, beadR, 0, 2 * Math.PI);
              ctx.fill();
            }
          } else if (style === "scallops") {
            ctx.strokeStyle = accent;
            ctx.lineWidth = Math.max(1.4, R * 0.02);
            ctx.beginPath();
            for (let k = 0; k <= N; k++) {
              const a0 = (k / N) * 2 * Math.PI;
              const a1 = ((k + 1) / N) * 2 * Math.PI;
              const p0 = rimPt(a0, 0);
              const midp = rimPt((a0 + a1) / 2, drop * 1.2);
              const p1 = rimPt(a1, 0);
              if (k === 0) ctx.moveTo(p0.x, p0.y);
              ctx.quadraticCurveTo(midp.x, midp.y, p1.x, p1.y);
            }
            ctx.stroke();
          } else if (style === "points") {
            ctx.fillStyle = accent;
            for (let k = 0; k < N; k++) {
              const a0 = (k / N) * 2 * Math.PI;
              const a1 = ((k + 1) / N) * 2 * Math.PI;
              const p0 = rimPt(a0, 0);
              const tip = rimPt((a0 + a1) / 2, drop * 1.5);
              const p1 = rimPt(a1, 0);
              ctx.beginPath();
              ctx.moveTo(p0.x, p0.y);
              ctx.lineTo(tip.x, tip.y);
              ctx.lineTo(p1.x, p1.y);
              ctx.closePath();
              ctx.fill();
            }
          } else {
            // swags — draped arcs with a bead at each vertex
            ctx.strokeStyle = accent;
            ctx.lineWidth = Math.max(1.2, R * 0.014);
            ctx.beginPath();
            for (let k = 0; k <= N; k++) {
              const a0 = (k / N) * 2 * Math.PI;
              const a1 = ((k + 1) / N) * 2 * Math.PI;
              const p0 = rimPt(a0, drop * 0.25);
              const midp = rimPt((a0 + a1) / 2, drop * 1.3);
              const p1 = rimPt(a1, drop * 0.25);
              if (k === 0) ctx.moveTo(p0.x, p0.y);
              ctx.quadraticCurveTo(midp.x, midp.y, p1.x, p1.y);
            }
            ctx.stroke();
            ctx.fillStyle = accent;
            for (let k = 0; k < N; k++) {
              const p = rimPt((k / N) * 2 * Math.PI, drop * 0.25);
              ctx.beginPath();
              ctx.arc(p.x, p.y, beadR * 0.8, 0, 2 * Math.PI);
              ctx.fill();
            }
          }
        }
      }

      // -- the wire drawing (contours) — gilds as the canopy comes alive ---
      if (P.wire > 0) {
        // Staggered so the contours visibly get DRAWN: ribs first, then the
        // inner rings, then the scalloped edge closes the figure.
        const ribP = clamp01(P.wire / 0.45);
        const ringP = clamp01((P.wire - 0.25) / 0.45);
        const edgeP = clamp01((P.wire - 0.5) / 0.5);
        // Ink while it is only a wire drawing; warms (and thickens) toward
        // this canopy's own trim color as the pink/white floods in over it.
        const gild = smooth(P.revive);
        const trim = lerpCol(INK, u.border, gild);
        ctx.globalAlpha = appear;
        ctx.strokeStyle = trim;
        ctx.lineWidth = Math.max(1, R * (0.014 + 0.009 * gild));
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
        // Concentric rib rings — three of them once alive, for an ornate
        // ribbed canopy (the outer two draw during the wire build).
        for (const ringR of [0.4, 0.68, 0.88]) {
          if (ringP <= 0) break;
          // The innermost extra ring only earns its place in the revival.
          if (ringR === 0.4 && gild < 0.15) continue;
          const total = 56;
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

        // -- shaft, finial and crook handle: the third dimension -----------
        if (P.shaft > 0) {
          ctx.globalAlpha = appear * P.shaft;
          // A stout shaft that warms to a dusty-rose handle when alive.
          ctx.strokeStyle = lerpCol(INK, HANDLE, gild);
          ctx.lineWidth = Math.max(1.4, R * (0.022 + 0.008 * gild));
          const axis = (/** @type {number} */ z) =>
            toScreen({ x: 0, y: 0, z }, f);
          const tip = axis(domeH + 0.2 * R);
          const apex = axis(domeH);
          const bottom = axis(-0.95 * R);
          ctx.beginPath();
          ctx.moveTo(tip.x, tip.y);
          ctx.lineTo(apex.x, apex.y);
          ctx.moveTo(apex.x, apex.y);
          ctx.lineTo(bottom.x, bottom.y);
          ctx.stroke();
          // A finial knob at the very top, in this canopy's trim, once alive.
          if (gild > 0.05) {
            ctx.fillStyle = lerpCol(INK, u.border, gild);
            ctx.globalAlpha = appear * P.shaft * gild;
            ctx.beginPath();
            ctx.arc(tip.x, tip.y, Math.max(1.4, R * 0.028), 0, 2 * Math.PI);
            ctx.fill();
            ctx.globalAlpha = appear * P.shaft;
            ctx.strokeStyle = lerpCol(INK, HANDLE, gild);
          }
          // The J-crook handle, in the plane the spin carries around.
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

        // -- the dangling decorations: beaded fringe round every rim -------
        // "The decorations in the end": they only unspool once the canopy
        // is alive (deco ramps last) and only read in the tilted 3D view.
        if (P.deco > 0 && P.shaft > 0.15) {
          const strandsPerPanel = 4;
          const maxLen = 0.2 * R;
          const len = maxLen * P.deco;
          ctx.lineCap = "round";
          ctx.strokeStyle = u.border; // fringe thread in the rim's trim color
          ctx.lineWidth = Math.max(1, R * 0.012);
          const tasselR = Math.max(1.4, R * 0.024);
          for (let i = 0; i < PANELS; i++) {
            for (let j = 0; j < strandsPerPanel; j++) {
              const fr = (j + 0.5) / strandsPerPanel;
              const a = (i + fr) * panelA + u.spin;
              const edgeF = scallopFactor(fr, P.scallop, sc);
              const rr = R * edgeF;
              const bx = rr * Math.cos(a);
              const by = rr * Math.sin(a);
              // A gentle pendulum swing, unique per strand and per umbrella.
              const swing = 0.4 * Math.sin(t * 0.004 + a * 2.6 + u.phase * 1.3);
              const tx = -Math.sin(a); // tangential unit (x)
              const ty = Math.cos(a); // tangential unit (y)
              const rimZ = domeZ(1); // 0 — the rim
              const rim = toScreen({ x: bx, y: by, z: rimZ }, f);
              const mid = toScreen(
                { x: bx + swing * len * 0.5 * tx, y: by + swing * len * 0.5 * ty, z: rimZ - len * 0.5 },
                f
              );
              const tip = toScreen(
                { x: bx + swing * len * tx, y: by + swing * len * ty, z: rimZ - len },
                f
              );
              ctx.globalAlpha = appear * P.deco;
              ctx.beginPath();
              ctx.moveTo(rim.x, rim.y);
              ctx.quadraticCurveTo(mid.x, mid.y, tip.x, tip.y);
              ctx.stroke();
              // The tassel bead at the tip.
              ctx.fillStyle = CREAM;
              ctx.beginPath();
              ctx.arc(tip.x, tip.y, tasselR, 0, 2 * Math.PI);
              ctx.fill();
            }
          }
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

    // Forward: the timeline's own tail fade (P.fade). Reverse: P.fade doubles
    // as the fade-IN (t starts at the faded end) and we add a fade-OUT as the
    // rewind lands back on the vortex, so both ends resolve cleanly.
    canvas.style.opacity = String(reverse ? Math.min(P.fade, smooth(t / 700)) : P.fade);
    raf = requestAnimationFrame(frame);
  }

  raf = requestAnimationFrame(frame);
}
