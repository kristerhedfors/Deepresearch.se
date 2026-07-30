// The space-animations EMBEDDABLE renderer — the playable wireframe canvas
// (stage + HUD + pointer interaction + the per-kind scene runners) extracted
// from the /space/ gallery page so a matched scene can render ANYWHERE: the
// gallery card, and since feedback #18 the chat response area on both tiers
// (a "show a moonshot…" ask mounts the animation above the streamed answer).
//
// Self-contained on purpose: it injects its own scoped CSS (`sp-` classes)
// once per document, so no host page needs stage styling of its own, and the
// dark stage reads correctly on any page theme. All deterministic logic
// (registry, matchers, zoom math, mesh builders) stays in the pure core
// space-core.js; this module is the DOM + canvas glue — the same division as
// bash-core.js/bash-agent.js.
//
// Rendering rules (docs/SPACE-ANIMATIONS.md — do not "improve" them away):
// only stars glow (additive light is reserved for actual stars and the light
// pulse; bodies, craft, figures, terrain and rings stay unlit wireframe);
// real numbers (radii, orbit distances, periods, zoom ranges are true values;
// enlarged-for-visibility craft keep true orbit altitudes and the corner
// scale-note says so); segments longer than 2600 px are culled (near-camera
// blow-up streaks); the sun's glow radius is capped (drawGlow clamps at
// 1600 px); mounts animate only while on screen (IntersectionObserver).

import {
  BODIES, LIGHT_YEAR_KM,
  sceneById, zoomToDistance, distanceToZoom, formatKm, clamp,
  sphereMesh, orbitMesh, cylinderMesh, rocketMesh, satelliteMesh,
  starshipStackMesh, starshipShipMesh, superHeavyMesh, launchTowerMesh,
  SUPER_HEAVY_FRAC, STARSHIP_SHIP_FRAC,
  astronautMesh, landerMesh, terrainMesh, ringMesh,
  spherePatchGrid, launchCamDistKm, launchAltKm, launchGroundAngle, orbitSpeedKms,
  boosterReturnState, isCatchView,
  sphereSilhouette, facesCamera,
  rotX, rotY, rotZ, worldRot, projectPoint, mulberry32,
} from "./space-core.js";

// ---------------------------------------------------------------------------
// Bilingual UI strings owned by the renderer (the gallery page keeps its own
// page-chrome strings).

const UI = {
  hint: { en: "drag to rotate · pinch/scroll to zoom", sv: "dra för att rotera · nyp/skrolla för att zooma" },
  enlarged: { en: "craft enlarged for visibility — orbits to scale", sv: "farkoster förstorade för synlighet — banor i skala" },
  toScale: { en: "sizes and distances to scale", sv: "storlekar och avstånd i skala" },
  notToScale: { en: "figures stylized — terrain from lunar-like noise", sv: "figurer stiliserade — terräng ur månliknande brus" },
  play: { en: "pause", sv: "pausa" },
  more: { en: "More space animations →", sv: "Fler rymdanimationer →" },
};

export function scaleNoteFor(scene) {
  if (scene.kind === "surface") return UI.notToScale;
  const enlarged = scene.kind === "launch" ||
    (scene.config.orbiters || []).some((o) => o.displayKm);
  return enlarged ? UI.enlarged : UI.toScale;
}

// ---------------------------------------------------------------------------
// Injected stage CSS — one <style> per document, `sp-` scoped. Mirrors the
// gallery's original stage styling exactly (the page's card/typography CSS
// stays in /space/index.html).

const STAGE_CSS = `
.sp-stage { position: relative; border: 1px solid #1d2a45; border-radius: 12px; overflow: hidden; background: #03040a; }
.sp-stage canvas { display: block; width: 100%; height: 340px; touch-action: none; cursor: grab; }
.sp-stage canvas:active { cursor: grabbing; }
.sp-hud {
  position: absolute; left: 0; right: 0; bottom: 0; display: flex; gap: .5rem;
  align-items: center; padding: .5rem .7rem;
  background: linear-gradient(transparent, rgba(3,4,10,.85) 40%);
  font-size: .8rem; color: #8298ba;
}
.sp-hud button {
  background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.18);
  color: #d7e3f7; border-radius: 8px; padding: .25rem .55rem; font-size: .8rem; cursor: pointer;
}
.sp-hud input[type=range] { flex: 1; accent-color: #7fb4ee; min-width: 60px; }
.sp-hud .sp-dist { min-width: 5.5em; text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.sp-hint { position: absolute; top: .5rem; right: .7rem; font-size: .72rem; color: rgba(157,185,214,.55); pointer-events: none; }
.sp-scalenote { position: absolute; top: .5rem; left: .7rem; font-size: .72rem; color: rgba(157,185,214,.55); pointer-events: none; }
.sp-caption { margin: .45rem 0 0; font-size: .85rem; line-height: 1.45; opacity: .8; }
.sp-more { display: inline-block; margin-top: .3rem; font-size: .8rem; color: #7fb4ee; text-decoration: none; }
.sp-more:hover { text-decoration: underline; }
@media (max-width: 560px) { .sp-stage canvas { height: 280px; } }
`;

function ensureStyles(doc) {
  if (doc.getElementById("sp-embed-styles")) return;
  const style = doc.createElement("style");
  style.id = "sp-embed-styles";
  style.textContent = STAGE_CSS;
  doc.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Shared meshes (built once at unit/base scale, scaled per draw).

const SPHERE = sphereMesh(1, 7, 12, 24);
const SPHERE_FINE = sphereMesh(1, 9, 16, 32);

// ---------------------------------------------------------------------------
// Wireframe drawing.

/** Draws a mesh: scale + own rotation + position, then world rotation. */
function drawMesh(ctx, st, cam, mesh, opts) {
  const { scale = 1, pos = [0, 0, 0], spin = 0, tilt = 0, stroke, alpha = 0.9, width = 1 } = opts;
  const pts = new Array(mesh.verts.length);
  for (let i = 0; i < mesh.verts.length; i++) {
    let v = mesh.verts[i];
    v = [v[0] * scale, v[1] * scale, v[2] * scale];
    if (spin) v = rotY(v, spin);
    if (tilt) v = rotX(v, tilt);
    v = [v[0] + pos[0], v[1] + pos[1], v[2] + pos[2]];
    pts[i] = projectPoint(worldRot(v, st), cam);
  }
  ctx.strokeStyle = stroke;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = width;
  ctx.beginPath();
  for (const [a, b] of mesh.edges) {
    const p = pts[a], q = pts[b];
    if (!p || !q) continue;
    // Segments that blow up near the camera (a terrain line passing right
    // under the viewpoint) project to wild multi-thousand-px streaks — cull.
    if (Math.abs(p.x - q.x) + Math.abs(p.y - q.y) > 2600) continue;
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(q.x, q.y);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/** A body: full sphere when it projects large enough, else a small marker. */
function drawBody(ctx, st, cam, pos, radiusKm, hue, opts = {}) {
  const p = projectPoint(worldRot(pos, st), cam);
  if (!p) return null;
  const rPx = radiusKm * p.s;
  const stroke = `hsl(${hue} 45% 68%)`;
  if (rPx >= 3.5) {
    drawMesh(ctx, st, cam, rPx > 40 ? SPHERE_FINE : SPHERE, {
      scale: radiusKm, pos, spin: opts.spin || 0, tilt: opts.tilt || 0,
      stroke, alpha: 0.75,
    });
  } else {
    ctx.strokeStyle = stroke;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = 1;
    const m = Math.max(2, rPx);
    ctx.beginPath();
    ctx.moveTo(p.x - m, p.y); ctx.lineTo(p.x + m, p.y);
    ctx.moveTo(p.x, p.y - m); ctx.lineTo(p.x, p.y + m);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  return p;
}

function label(ctx, p, text, dy = -8) {
  if (!p) return;
  ctx.fillStyle = "rgba(190,212,240,0.6)";
  ctx.font = "11px system-ui, sans-serif";
  ctx.fillText(text, p.x + 7, p.y + dy);
}

/**
 * The launch scene's ground grid, sized to how much ground the camera can
 * actually see and cached per octave so a smooth dolly regenerates it only a
 * few times over the whole flight.
 */
function surfaceGridFor(st, camDistKm) {
  const span = clamp((3 * camDistKm) / st.planetR, 0.01, 0.95);
  const key = Math.round(Math.log(span) / Math.log(1.35));
  let grid = st.gridCache.get(key);
  if (!grid) {
    grid = spherePatchGrid(st.planetR, Math.PI / 2, Math.pow(1.35, key), 9, 38);
    // The dolly only ever walks a handful of octaves; keep the cache bounded.
    if (st.gridCache.size > 12) st.gridCache.clear();
    st.gridCache.set(key, grid);
  }
  return grid;
}

/** Additive glow — reserved for STARS and light itself (the domain's rule). */
function drawGlow(ctx, x, y, radius, hue = 45, strength = 1) {
  const r = Math.min(1600, radius);
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `hsla(${hue} 90% 85% / ${0.85 * strength})`);
  g.addColorStop(0.35, `hsla(${hue} 85% 65% / ${0.32 * strength})`);
  g.addColorStop(1, "transparent");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, 2 * Math.PI);
  ctx.fill();
  ctx.restore();
}

function drawStars(ctx, st, w, h, t) {
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const s of st.stars) {
    const tw = 0.55 + 0.45 * Math.sin(t * s.freq + s.phase);
    const x = s.x * w, y = s.y * h;
    const g = ctx.createRadialGradient(x, y, 0, x, y, s.r * 4);
    g.addColorStop(0, `hsla(${s.hue} 60% 92% / ${0.9 * tw})`);
    g.addColorStop(0.3, `hsla(${s.hue} 70% 75% / ${0.25 * tw})`);
    g.addColorStop(1, "transparent");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, s.r * 4, 0, 2 * Math.PI);
    ctx.fill();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Scene runners — one per scene `kind`. Each receives (ctx, st, cam, w, h)
// with st.time advanced by the play loop (seconds × speed).

const RUNNERS = {
  // True-scale size comparison: bodies in a row, slowly spinning.
  compare(ctx, st, cam) {
    const ids = st.scene.config.bodies;
    const gap = st.scene.config.gapFactor;
    // Lay out along x: touching plus a gap proportional to the pair.
    let x = 0;
    const placed = [];
    let prevR = 0;
    for (const id of ids) {
      const b = BODIES[id];
      x += prevR + b.radiusKm + (prevR ? gap * (prevR + b.radiusKm) : 0);
      placed.push({ b, x });
      prevR = b.radiusKm;
    }
    const width = x + prevR;
    let lastLabelX = -Infinity;
    for (const pl of placed) {
      const pos = [pl.x - width / 2, 0, 0];
      if (pl.b === BODIES.sun) {
        const pp = projectPoint(worldRot(pos, st), cam);
        if (pp) drawGlow(ctx, pp.x, pp.y, Math.max(14, pl.b.radiusKm * pp.s * 1.25), 45, 0.8);
      }
      const p = drawBody(ctx, st, cam, pos, pl.b.radiusKm, pl.b.hue, { spin: st.time * 0.15 });
      // Zoomed out, the small bodies bunch up — drop labels that would
      // overprint the previous one.
      if (p && p.x - lastLabelX > 90) {
        label(ctx, p, `${st.lang === "sv" ? pl.b.nameSv : pl.b.name} · r ${formatKm(pl.b.radiusKm)}`);
        lastLabelX = p.x;
      }
    }
  },

  // A central body with orbiters on inclined circular orbits.
  orbits(ctx, st, cam) {
    const cfg = st.scene.config;
    const center = BODIES[cfg.center];
    if (cfg.center === "sun") {
      const pp = projectPoint(worldRot([0, 0, 0], st), cam);
      if (pp) drawGlow(ctx, pp.x, pp.y, Math.max(10, center.radiusKm * pp.s * 2.5), 45, 0.7);
    }
    const cp = drawBody(ctx, st, cam, [0, 0, 0], center.radiusKm, center.hue, { spin: st.time * 0.2 });
    label(ctx, cp, st.lang === "sv" ? center.nameSv : center.name);
    for (const orb of st.orbiters) {
      drawMesh(ctx, st, cam, orb.path, { stroke: "rgba(130,152,186,0.8)", alpha: 0.28 });
      const period = orb.periodDays;
      for (let k = 0; k < orb.count; k++) {
        const th = (2 * Math.PI * ((st.simDays / period) + k / orb.count + orb.seed)) % (2 * Math.PI);
        let pos = [orb.orbitKm * Math.cos(th), 0, orb.orbitKm * Math.sin(th)];
        pos = rotY(rotX(pos, orb.incl), orb.node + (k * orb.nodeStep));
        if (orb.mesh === "satellite") {
          drawMesh(ctx, st, cam, orb.satMesh, {
            pos, spin: st.time * 0.5 + k, stroke: "hsl(200 45% 72%)", alpha: 0.9,
          });
          if (k === 0) {
            const p = projectPoint(worldRot(pos, st), cam);
            label(ctx, p, orb.label);
          }
        } else {
          const b = BODIES[orb.body];
          const p = drawBody(ctx, st, cam, pos, b.radiusKm, b.hue, { spin: st.time * 0.3 });
          if (p) label(ctx, p, `${st.lang === "sv" ? b.nameSv : b.name} · ${formatKm(orb.orbitKm)}`);
        }
      }
    }
  },

  // Gravity turn to orbit, with stage separation. st.u loops 0..1.
  // (surfaceGridFor sizes the ground grid to the camera — see below.)
  launch(ctx, st, cam, w, h) {
    const cfg = st.scene.config;
    const R = BODIES[cfg.planet].radiusKm;
    const alt = cfg.orbitAltKm;
    const u = st.u;
    const insert = cfg.insertT;
    const rocketState = (uu) => ({ a: launchAltKm(uu, cfg), phi: launchGroundAngle(uu, cfg) });
    const toWorld = (s) => {
      // Planet center at origin; launch site at angle π/2 (up).
      const ang = Math.PI / 2 - s.phi;
      const r = R + s.a;
      return [r * Math.cos(ang), r * Math.sin(ang), 0];
    };
    const rs = rocketState(u);
    const rpos = toWorld(rs);
    // The world is drawn relative to whatever the view is riding. Normally
    // that is the craft, but a scene that flies its booster home cuts to the
    // booster for the catch — otherwise the catch plays out a thousand km
    // off-frame while the camera watches the Ship.
    const caught = cfg.catchT != null && u >= cfg.catchT;
    // The catch label and the pad's own "launch site" label land on the same
    // spot — the booster is IN the tower — so only one of them is ever drawn.
    const showCatchLabel = caught && u < cfg.catchT + 0.12;
    const bs = cfg.catchT != null ? boosterReturnState(u, cfg) : null;
    const bpos = bs ? toWorld(bs) : null;
    const onBooster = bs != null && isCatchView(u, cfg);
    const anchor = onBooster ? bpos : rpos;
    const rel = (p) => [p[0] - anchor[0], p[1] - anchor[1], p[2] - anchor[2]];
    const siteAng = Math.PI / 2;
    // The launch site itself, and the ground under it.
    const sitePos = [R * Math.cos(siteAng), R * Math.sin(siteAng), 0];
    // The planet's centre in the camera-rotated frame — every bit of planet
    // geometry below is measured from it.
    const C = worldRot(rel([0, 0, 0]), st);
    // Draw a polyline of already-rotated points, dropping the near-camera
    // segments that would project to multi-thousand-px streaks (drawMesh's
    // guard, which this hand-rolled path has to repeat).
    const stroke = (pts, keep) => {
      ctx.beginPath();
      let prev = null;
      let top = null;
      for (const q of pts) {
        const p = keep && !keep(q) ? null : projectPoint(q, cam);
        if (!p) { prev = null; continue; }
        if (prev && Math.hypot(p.x - prev.x, p.y - prev.y) > 2600) { prev = null; continue; }
        if (!prev) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
        if (!top || p.y < top.y) top = p;
        prev = p;
      }
      ctx.stroke();
      return top;
    };
    // Surface graticule: the ground around the pad, curving away to the
    // horizon. Without it the horizon alone reads as one more orbit ring and
    // the planet is invisible (feedback #46). The far half is culled — it
    // would otherwise draw straight over the near half.
    ctx.strokeStyle = "hsl(205 40% 58%)";
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.34;
    for (const line of surfaceGridFor(st, cam.dist)) {
      stroke(line.map((pt) => worldRot(rel(pt), st)), (q) => facesCamera(q, C, cam.dist));
    }
    ctx.globalAlpha = 1;
    // The horizon, and the two shells above it. Each is the TRUE silhouette
    // of its sphere, so the ground grid meets the horizon instead of crossing
    // it once the view is rotated.
    const sv = st.lang === "sv";
    // Zoomed out, the three shells are only a few px apart and their labels
    // would overlap into mush — so they are placed in priority order and any
    // that lands on top of one already placed is dropped.
    const placed = [];
    const tag = (top, text, alpha) => {
      if (!top || top.y < 14 || top.y > cam.cy * 2 - 56) return;
      const y = top.y - 5;
      if (placed.some((p) => Math.abs(p - y) < 14)) return;
      placed.push(y);
      ctx.fillStyle = `rgba(190,212,240,${alpha})`;
      ctx.font = "11px system-ui, sans-serif";
      ctx.fillText(text, 12, y);
    };
    // The target orbit.
    ctx.strokeStyle = "hsl(205 45% 62%)";
    ctx.setLineDash([4, 6]);
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = 1;
    const orbTop = stroke(sphereSilhouette(C, R + alt, cam.dist));
    ctx.setLineDash([]);
    // The atmosphere: the Kármán line at 100 km, where "space" begins.
    ctx.strokeStyle = "hsl(198 50% 66%)";
    ctx.globalAlpha = 0.3;
    const karTop = stroke(sphereSilhouette(C, R + 100, cam.dist));
    // The surface.
    ctx.strokeStyle = "hsl(205 55% 68%)";
    ctx.globalAlpha = 0.95;
    ctx.lineWidth = 1.8;
    const surfTop = stroke(sphereSilhouette(C, R, cam.dist));
    ctx.globalAlpha = 1;
    // Name them, so what is planet and what is orbit is not a guess. Earth
    // goes first: it is the one the viewer must not miss (feedback #46).
    tag(surfTop, sv ? "Jorden · yta" : "Earth · surface", 0.7);
    tag(orbTop, sv ? `målbana · ${formatKm(alt)}` : `target orbit · ${formatKm(alt)}`, 0.45);
    tag(karTop, sv ? "Kármánlinjen · 100 km" : "Kármán line · 100 km", 0.4);
    // The pad the rocket left, marked on the ground.
    const siteQ = worldRot(rel(sitePos), st);
    const sp = facesCamera(siteQ, C, cam.dist) ? projectPoint(siteQ, cam) : null;
    if (sp && sp.s > 0) {
      const m = 5;
      ctx.strokeStyle = "hsl(30 45% 70%)";
      ctx.globalAlpha = 0.75;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sp.x - m, sp.y); ctx.lineTo(sp.x + m, sp.y);
      ctx.moveTo(sp.x, sp.y - m); ctx.lineTo(sp.x, sp.y + m);
      ctx.stroke();
      ctx.globalAlpha = 1;
      // Not once it has slid under the HUD, where it only half-renders.
      if (u > 0.02 && !showCatchLabel && sp.y + 14 < cam.cy * 2 - 56) {
        label(ctx, sp, st.lang === "sv" ? "startplats" : "launch site", 14);
      }
    }
    // Flown trajectory.
    ctx.strokeStyle = "rgba(127,180,238,0.5)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i <= 60; i++) {
      const p = projectPoint(worldRot(rel(toWorld(rocketState((u * i) / 60))), st), cam);
      if (!p) { started = false; continue; }
      if (!started) { ctx.moveTo(p.x, p.y); started = true; } else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    // The rocket, oriented along its velocity, drawn enlarged to stay visible.
    const eps = 0.004;
    const ahead = toWorld(rocketState(Math.min(1, u + eps)));
    const vel = [ahead[0] - rpos[0], ahead[1] - rpos[1], 0];
    const vAng = Math.atan2(vel[0], vel[1]);
    // Big enough to READ as the vehicle it is. Held at a constant fraction of
    // the camera distance the craft keeps one screen size the whole way up;
    // at 0.045 that was ~18 px on a phone, which is a smudge — feedback #58,
    // *"it doesn't look like starship plus booster"*, is what an 18 px stack
    // looks like. 0.1 is ~40 px, enough for the booster's grid fins and the
    // Ship's flaps to separate. The cap is what stops the same rule drawing a
    // 1,500 km rocket across Earth once the orbit reveal pulls the camera out.
    const size = Math.min(Math.max(0.07, st.camDist * 0.1), R * 0.08);
    const staged = u >= cfg.stageT;
    // The catch tower at the pad, drawn at the SAME enlarged `size` as the
    // craft so the two keep their true proportions to each other (a real
    // tower is a little taller than the stack). Its arms are open while the
    // booster is away and closed once it has been caught.
    // Ground structures are enlarged like the craft, but only up to a point:
    // held at constant SCREEN size all the way out to the orbit reveal, the
    // tower becomes a 1,000 km spike off Earth's limb. Past that cap it
    // shrinks into the pad marker, which is the honest thing at that distance.
    const groundSize = Math.min(size, R * 0.015);
    if (cfg.tower && st.towerMesh) {
      // Stood exactly on the pad the tower and the stack draw through each
      // other and the pair reads as one scribble at liftoff. It is set back
      // along the ground by its own arm reach — arms pointing downrange, at
      // the vehicle — which is where a catch tower actually stands.
      const back = groundSize * 0.34;
      const towerPos = rel([sitePos[0] - back, sitePos[1], sitePos[2]]);
      drawMesh(ctx, st, cam, caught ? st.towerClosed : st.towerMesh, {
        scale: groundSize, pos: towerPos, stroke: "hsl(30 32% 62%)", alpha: 0.8, width: 1,
      });
      // Name the catch where it happens, for the moment it happens — the
      // readout at the bottom is easy to miss while watching the descent.
      if (showCatchLabel) {
        const tp = projectPoint(worldRot(towerPos, st), cam);
        if (tp && tp.s > 0 && tp.y > 20 && tp.y + 14 < cam.cy * 2 - 56) {
          label(ctx, tp, sv ? "bottensteget fångat" : "booster caught", 14);
        }
      }
    }
    const rocket = staged ? st.upperMesh : st.fullMesh;
    // Orient the unit-height mesh along the velocity, then scale. The
    // trajectory point is the vehicle's BASE, not its middle: centring it sank
    // half the stack under the pad at liftoff, which only became visible once
    // the craft was drawn big enough to see (feedback #58). Base-anchored it
    // also matches the booster below, which drew from its base all along.
    // Once staged, the upper stage keeps the place it held on the stack —
    // it does not slide down into the booster's. The booster drops away from
    // beneath it, which is the direction separation actually goes.
    const lift = staged ? st.upperOffset : 0;
    const oriented = {
      verts: rocket.verts.map((v) => {
        const r = rotZ([v[0], v[1] + lift, v[2]], -vAng);
        return [r[0] * size, r[1] * size, r[2] * size];
      }),
      edges: rocket.edges,
    };
    const craftPos = rel(rpos);
    drawMesh(ctx, st, cam, oriented, {
      pos: craftPos, stroke: "hsl(30 55% 72%)", alpha: 0.95, width: 1.2,
    });
    // Wireframe exhaust while thrusting (lines, not light).
    if (u < insert) {
      ctx.strokeStyle = "hsl(38 70% 70%)";
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      // Just under whichever engines are lit — the stack's at the base, the
      // Ship's up where it separated from — and trailing along the vehicle's
      // OWN axis. Drawn straight down the screen it pointed off into space
      // once the craft was pitched over, which the bigger craft made obvious.
      const along = (d) => projectPoint(worldRot([
        craftPos[0] + Math.sin(vAng) * d,
        craftPos[1] + Math.cos(vAng) * d,
        craftPos[2],
      ], st), cam);
      const tail = along((lift - 0.04) * size);
      const plume = along((lift - 0.34) * size);
      if (tail && plume) {
        const jitter = Math.sin(st.time * 40) * 3;
        // Perpendicular to the plume, so the two edges straddle the nozzle
        // whatever attitude the craft is holding.
        const dx = plume.x - tail.x, dy = plume.y - tail.y;
        const len = Math.hypot(dx, dy) || 1;
        const px = -dy / len, py = dx / len;
        ctx.moveTo(tail.x + px * 3, tail.y + py * 3);
        ctx.lineTo(plume.x + px * jitter * 0.3, plume.y + py * jitter * 0.3);
        ctx.moveTo(tail.x - px * 3, tail.y - py * 3);
        ctx.lineTo(plume.x - px * jitter * 0.3, plume.y - py * jitter * 0.3);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // Boostback and the catch: the booster flips, burns back toward the pad it
    // left, and is then HELD at the tower — it never falls away. That return
    // is the whole point of the vehicle, so it plays out in full.
    if (bs && staged) {
      drawMesh(ctx, st, cam, st.boosterMesh, {
        // Sitting in the tower it is a ground structure too, and takes the cap.
        scale: caught ? groundSize : size,
        pos: rel(bpos),
        // Flips engines-first to burn back, and is upright again for the catch.
        tilt: Math.sin(Math.PI * bs.k) * 2.6,
        stroke: "hsl(30 32% 58%)",
        alpha: caught ? 0.85 : 0.7,
      });
    } else if (!bs && staged && u < cfg.stageT + 0.22) {
      const k = (u - cfg.stageT) / 0.22;
      const ss = rocketState(cfg.stageT);
      const bs = { a: ss.a * (1 - k * k), phi: ss.phi + k * 0.01 };
      const bpos = rel(toWorld(bs));
      drawMesh(ctx, st, cam, st.boosterMesh, {
        scale: size * 0.8, pos: bpos, tilt: k * 2, stroke: "hsl(30 30% 55%)", alpha: 0.7,
      });
    }
    // Readout: altitude + phase.
    ctx.fillStyle = "rgba(190,212,240,0.7)";
    ctx.font = "11px system-ui, sans-serif";
    // The insertion speed is the real circular-orbit speed for this scene's
    // altitude, not a constant: 400 km gives 7.7 km/s, 200 km gives 7.8.
    const vOrb = orbitSpeedKms(alt).toFixed(1);
    const inOrbit = sv ? `i omloppsbana · ${vOrb.replace(".", ",")} km/s` : `in orbit · ${vOrb} km/s`;
    const phase = cfg.craft === "starship"
      ? (u < cfg.stageT
        ? (sv ? "Super Heavy — 33 Raptormotorer" : "Super Heavy — 33 Raptor engines")
        : u < cfg.catchT
          ? (sv ? "hetseparation — bottensteget vänder hem" : "hot-stage — booster burning back")
          : u < insert
            ? (sv ? "bottensteget fångat — Ship mot banfart" : "booster caught — Ship building orbital speed")
            : inOrbit)
      : u < cfg.stageT
        ? (sv ? "steg 1 — gravitationssväng" : "stage 1 — gravity turn")
        : u < insert
          ? (sv ? "steg 2 — mot banfart" : "stage 2 — building orbital speed")
          : inOrbit;
    // Bottom-left, above the HUD (the corner notes own the top edge).
    ctx.fillText(`${st.lang === "sv" ? "höjd" : "alt"} ${formatKm(rs.a)} · ${phase}`, 10, h - 48);
  },

  // Standing on the Moon: terrain, astronaut, lander, flag, Earth in the sky.
  surface(ctx, st, cam) {
    drawMesh(ctx, st, cam, st.terrain, { stroke: "hsl(220 8% 62%)", alpha: 0.4 });
    drawMesh(ctx, st, cam, st.astro, { pos: st.astroPos, spin: 0.4, stroke: "hsl(0 0% 88%)", alpha: 0.95, width: 1.2 });
    drawMesh(ctx, st, cam, st.lander, { pos: st.landerPos, stroke: "hsl(45 25% 70%)", alpha: 0.8 });
    drawMesh(ctx, st, cam, st.flag, { pos: st.flagPos, stroke: "hsl(205 50% 75%)", alpha: 0.9 });
    // Earth in the black sky (not to scale — a presence, not a measurement).
    const ep = drawBody(ctx, st, cam, st.earthPos, 0.09, 205, { spin: st.time * 0.05 });
    label(ctx, ep, st.lang === "sv" ? "Jorden" : "Earth");
  },

  // Saturn: tilted sphere, ring frame, particles at Kepler speeds.
  rings(ctx, st, cam) {
    const cfg = st.scene.config;
    const b = BODIES[cfg.body];
    const tilt = (cfg.tiltDeg * Math.PI) / 180;
    drawMesh(ctx, st, cam, SPHERE_FINE, { scale: b.radiusKm, pos: [0, 0, 0], spin: st.time * 0.3, tilt, stroke: `hsl(${b.hue} 45% 68%)`, alpha: 0.75 });
    drawMesh(ctx, st, cam, st.ringFrame, { tilt, stroke: "hsl(45 30% 70%)", alpha: 0.3 });
    // Particles: each on its own Kepler orbit — inner faster (ω ∝ r^-1.5).
    ctx.fillStyle = "rgba(230,225,205,0.8)";
    for (const pt of st.particles) {
      const th = pt.phase + st.time * pt.omega;
      let v = [pt.r * Math.cos(th), pt.y, pt.r * Math.sin(th)];
      v = rotX(v, tilt);
      const p = projectPoint(worldRot(v, st), cam);
      if (p) ctx.fillRect(p.x, p.y, 1.2, 1.2);
    }
    const ip = projectPoint(worldRot(rotX([cfg.ringInnerKm, 0, 0], tilt), st), cam);
    label(ctx, ip, `${formatKm(cfg.ringInnerKm)} → ${formatKm(cfg.ringOuterKm)}`, 14);
  },

  // The Solar System shrinking toward the nearest star.
  travel(ctx, st, cam) {
    const cfg = st.scene.config;
    const sunP = projectPoint(worldRot([0, 0, 0], st), cam);
    if (sunP) drawGlow(ctx, sunP.x, sunP.y, Math.max(8, BODIES.sun.radiusKm * sunP.s * 3), 45, 0.85);
    const sp = drawBody(ctx, st, cam, [0, 0, 0], BODIES.sun.radiusKm, 45);
    label(ctx, sp, st.lang === "sv" ? "Solen" : "Sun");
    for (const id of ["mercury", "venus", "earth", "mars", "jupiter", "saturn", "uranus", "neptune"]) {
      const b = BODIES[id];
      drawMesh(ctx, st, cam, st.orbitPaths[id], { stroke: "rgba(130,152,186,0.7)", alpha: 0.25 });
      const th = (2 * Math.PI * st.simDays) / b.periodDays;
      const pos = [b.orbitKm * Math.cos(th), 0, b.orbitKm * Math.sin(th)];
      const p = drawBody(ctx, st, cam, pos, b.radiusKm, b.hue);
      if (id === "earth" || id === "neptune") label(ctx, p, st.lang === "sv" ? b.nameSv : b.name);
    }
    // Proxima: a real star — it glows.
    const D = cfg.starDistanceLy * LIGHT_YEAR_KM;
    const dir = st.starDir;
    const starPos = [dir[0] * D, dir[1] * D, dir[2] * D];
    const pp = projectPoint(worldRot(starPos, st), cam);
    if (pp && pp.x > -50 && pp.x < ctx.canvas.clientWidth + 50) {
      drawGlow(ctx, pp.x, pp.y, 9, 10, 0.9);
      label(ctx, pp, `${cfg.starName} · 4.25 ly`);
    }
    // The line to it, and light itself crawling along (glowing — it IS light).
    ctx.strokeStyle = "rgba(127,180,238,0.35)";
    ctx.setLineDash([3, 9]);
    ctx.beginPath();
    if (sunP && pp) { ctx.moveTo(sunP.x, sunP.y); ctx.lineTo(pp.x, pp.y); }
    ctx.stroke();
    ctx.setLineDash([]);
    const years = (st.simDays / 365.25) % cfg.starDistanceLy;
    const lp = projectPoint(worldRot([dir[0] * years * LIGHT_YEAR_KM, dir[1] * years * LIGHT_YEAR_KM, dir[2] * years * LIGHT_YEAR_KM], st), cam);
    if (lp) {
      drawGlow(ctx, lp.x, lp.y, 5, 200, 0.8);
      label(ctx, lp, st.lang === "sv" ? `ljus · år ${years.toFixed(1)}` : `light · year ${years.toFixed(1)}`, 16);
    }
  },
};

// ---------------------------------------------------------------------------
// Per-mount scene state.

function buildSceneState(scene, canvas, lang) {
  const st = {
    scene, canvas, ctx: canvas.getContext("2d"), lang,
    playing: true, speed: 1, visible: false,
    zoom: distanceToZoom(scene.zoomKm.start, scene.zoomKm.min, scene.zoomKm.max),
    camDist: scene.zoomKm.start,
    rotX: 0.35, rotY: 0.5, time: 0, simDays: 0, u: 0,
    stars: [],
  };
  const rnd = mulberry32(scene.id.length * 1013 + scene.id.charCodeAt(0));
  for (let i = 0; i < 130; i++) {
    st.stars.push({
      x: rnd(), y: rnd(), r: 0.4 + rnd() * 1.1,
      phase: rnd() * Math.PI * 2, freq: 0.4 + rnd() * 1.6,
      hue: 195 + rnd() * 50,
    });
  }
  // Kind-specific precomputation.
  if (scene.kind === "orbits") {
    st.orbiters = scene.config.orbiters.map((o, i) => {
      const body = o.body ? BODIES[o.body] : null;
      const orbitKm = o.orbitKm ?? body.orbitKm;
      const periodDays = o.periodDays ?? body.periodDays;
      const incl = ((o.inclinationDeg || 0) * Math.PI) / 180;
      const node = i * 0.9;
      const path = orbitMesh(orbitKm, 128);
      path.verts = path.verts.map((v) => rotY(rotX(v, incl), node));
      return {
        ...o, orbitKm, periodDays, incl, node,
        count: o.count || 1,
        nodeStep: o.count ? (2 * Math.PI) / o.count : 0,
        seed: i * 0.17,
        path,
        satMesh: o.mesh === "satellite" ? satelliteMesh(o.displayKm || 500) : null,
        label: o.name || "",
      };
    });
    // Fastest orbiter completes a lap in ~14 s at ×1.
    const fastest = Math.min(...st.orbiters.map((o) => o.periodDays));
    st.daysPerSec = fastest / 14;
  }
  if (scene.kind === "travel") {
    st.orbitPaths = {};
    for (const id of ["mercury", "venus", "earth", "mars", "jupiter", "saturn", "uranus", "neptune"]) {
      st.orbitPaths[id] = orbitMesh(BODIES[id].orbitKm, 96);
    }
    const d = [1, 0.1, -0.28];
    const n = Math.hypot(...d);
    st.starDir = d.map((x) => x / n);
    st.daysPerSec = 365.25 * 0.45; // light crosses in ~9.5 s at ×1
  }
  if (scene.kind === "launch") {
    if (scene.config.craft === "starship") {
      // The stack is one unit tall like rocketMesh(1), so the camera dolly and
      // the `size` scaling below need no special case.
      st.fullMesh = starshipStackMesh(1);
      // The Ship keeps the size it had ON the stack once it separates.
      st.upperMesh = starshipShipMesh(STARSHIP_SHIP_FRAC);
      st.boosterMesh = superHeavyMesh(SUPER_HEAVY_FRAC);
      // Where the upper stage sat ON the stack, as a fraction of stack height.
      // The trajectory point tracks the vehicle's BASE, so without this the
      // upper stage snaps down into the booster's place at separation and the
      // eye reads it as the FRONT falling away — reported exactly that way:
      // "separation seems to drop the front part, the starship rather than
      // the stage below" (feedback #58).
      st.upperOffset = 1 - STARSHIP_SHIP_FRAC;
      st.towerMesh = launchTowerMesh(1.2);
      st.towerClosed = launchTowerMesh(1.2, 0);
    } else {
      st.fullMesh = rocketMesh(1);
      st.upperMesh = rocketMesh(0.55);
      st.boosterMesh = cylinderMesh(0.09, 0.5, 8);
      st.upperOffset = 0.45;
    }
    st.loopSec = 26;
    // The ground around the pad; the limb alone does not read as a planet.
    // The ground grid is sized to the camera, not fixed: one spacing cannot
    // serve both ends of the dolly — on the pad a coarse grid has no line
    // inside the ~900 km horizon, and from orbit a fine one is a solid smear.
    // Spans are cached per octave so this regenerates a handful of times over
    // the whole flight rather than every frame.
    st.planetR = BODIES[scene.config.planet].radiusKm;
    st.gridCache = new Map();
    // The camera follows the flight (ground → orbit) until the viewer takes
    // the zoom control, after which it is theirs.
    st.autoZoom = true;
  }
  if (scene.kind === "surface") {
    st.terrain = terrainMesh(scene.config.terrainKm, 44, 7, 0.022);
    // Stand the astronaut on the terrain: find the vertex nearest the center.
    let best = [0, 0, 0], bestD = Infinity;
    for (const v of st.terrain.verts) {
      const d = v[0] * v[0] + v[2] * v[2];
      if (d < bestD) { bestD = d; best = v; }
    }
    st.astro = astronautMesh(0.0018);
    st.astroPos = [best[0], best[1], best[2]];
    st.lander = landerMesh(0.007);
    st.landerPos = [best[0] + 0.028, best[1], best[2] - 0.02];
    st.flag = {
      verts: [[0, 0, 0], [0, 0.0025, 0], [0.0016, 0.0025, 0], [0.0016, 0.0019, 0], [0, 0.0019, 0]],
      edges: [[0, 1], [1, 2], [2, 3], [3, 4]],
    };
    st.flagPos = [best[0] - 0.006, best[1], best[2] + 0.004];
    const ed = [0.5, 0.5, -0.65];
    const en = Math.hypot(...ed);
    st.earthPos = ed.map((x) => (x / en) * 6);
    st.rotX = 0.12;
  }
  if (scene.kind === "rings") {
    const cfg = scene.config;
    st.ringFrame = ringMesh(cfg.ringInnerKm, cfg.ringOuterKm, 6, 120);
    const rnd2 = mulberry32(99);
    st.particles = [];
    const omegaInner = (2 * Math.PI) / 15; // inner edge laps in 15 s at ×1
    for (let i = 0; i < cfg.particles; i++) {
      const r = cfg.ringInnerKm + rnd2() * (cfg.ringOuterKm - cfg.ringInnerKm);
      st.particles.push({
        r, phase: rnd2() * Math.PI * 2,
        y: (rnd2() - 0.5) * 300,
        omega: omegaInner * Math.pow(cfg.ringInnerKm / r, 1.5),
      });
    }
  }
  if (scene.kind === "compare") st.rotX = 0.15;
  return st;
}

// ---------------------------------------------------------------------------
// The shared play loop: one rAF drives every mount on the page; a mount draws
// only while its stage intersects the viewport (nine always-running canvases
// would melt a phone — the gallery's rule, kept for chat).

const mounts = new Set();
let loopRunning = false;
let lastTs = 0;

function frame(ts) {
  if (!mounts.size) { loopRunning = false; return; }
  const dt = Math.min(0.1, (ts - lastTs) / 1000 || 0);
  lastTs = ts;
  for (const st of mounts) {
    if (!st.visible) continue;
    if (st.playing) {
      st.time += dt * st.speed;
      if (st.daysPerSec) st.simDays += dt * st.speed * st.daysPerSec;
      if (st.scene.kind === "launch") st.u = (st.u + (dt * st.speed) / st.loopSec) % 1;
    }
    draw(st);
  }
  requestAnimationFrame(frame);
}

function startLoop() {
  if (loopRunning) return;
  loopRunning = true;
  lastTs = 0;
  requestAnimationFrame(frame);
}

function draw(st) {
  const canvas = st.canvas;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = st.ctx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  drawStars(ctx, st, w, h, st.time);
  // The launch scene flies its own camera — pad to orbit — until the viewer
  // takes the zoom control (st.autoZoom goes false and stays false).
  if (st.autoZoom && st.scene.kind === "launch") {
    const cfg = st.scene.config;
    // While the view rides the returning booster, the dolly rides it too —
    // closing in as it comes down so the tower catch is actually watchable
    // instead of a two-pixel event at the edge of frame.
    const onBooster = isCatchView(st.u, cfg);
    const altKm = onBooster
      ? boosterReturnState(st.u, cfg).a
      : launchAltKm(st.u, cfg);
    const d = onBooster
      ? Math.max(st.scene.zoomKm.min, cfg.catchCamKm ?? st.scene.zoomKm.min * 1.6)
      : launchCamDistKm(st.u, altKm, cfg, st.scene.zoomKm);
    if (d !== st.camDist) {
      st.camDist = d;
      if (st.onCamDist) st.onCamDist(d);
    }
  }
  const cam = { dist: st.camDist, f: 1.15 * Math.min(w, h), cx: w / 2, cy: h / 2 };
  RUNNERS[st.scene.kind](ctx, st, cam, w, h);
}

// ---------------------------------------------------------------------------
// The mount API.

/**
 * Mounts a playable scene into `host`: stage (canvas + hint + scale note +
 * HUD with play/speed/zoom/reset), pointer interaction, and — for the chat
 * embed — the scene's curated factual reply as a caption plus a link to the
 * /space/ archive. Returns a handle or null for an unknown scene.
 *
 * @param {HTMLElement} host container the embed is appended to
 * @param {string|object} sceneOrId scene id (or a registry entry)
 * @param {{lang?: "en"|"sv", caption?: boolean, moreLink?: boolean}} [opts]
 * @returns {{el: HTMLElement, state: object, setLang: (l: string) => void, destroy: () => void} | null}
 */
export function mountSpaceScene(host, sceneOrId, opts = {}) {
  const scene = typeof sceneOrId === "string" ? sceneById(sceneOrId) : sceneOrId;
  if (!scene || !host || !RUNNERS[scene.kind]) return null;
  let lang = opts.lang === "sv" ? "sv" : "en";
  const doc = host.ownerDocument;
  ensureStyles(doc);

  const wrap = doc.createElement("div");
  wrap.className = "sp-embed";
  const stage = doc.createElement("div");
  stage.className = "sp-stage";
  const canvas = doc.createElement("canvas");
  stage.appendChild(canvas);
  const hint = doc.createElement("div");
  hint.className = "sp-hint";
  stage.appendChild(hint);
  const scaleNote = doc.createElement("div");
  scaleNote.className = "sp-scalenote";
  stage.appendChild(scaleNote);
  const hud = doc.createElement("div");
  hud.className = "sp-hud";
  hud.innerHTML = `
    <button class="sp-play" type="button">⏸</button>
    <button class="sp-speed" type="button">×1</button>
    <input class="sp-zoom" type="range" min="0" max="1000" step="1">
    <span class="sp-dist"></span>
    <button class="sp-reset" type="button" title="reset view">↺</button>`;
  stage.appendChild(hud);
  wrap.appendChild(stage);

  let caption = null;
  if (opts.caption !== false) {
    caption = doc.createElement("p");
    caption.className = "sp-caption";
    wrap.appendChild(caption);
  }
  let more = null;
  if (opts.moreLink) {
    more = doc.createElement("a");
    more.className = "sp-more";
    more.href = "/space/";
    more.target = "_blank";
    more.rel = "noopener";
    wrap.appendChild(more);
  }
  host.appendChild(wrap);

  const st = buildSceneState(scene, canvas, lang);

  // --- HUD wiring -----------------------------------------------------------
  const playBtn = hud.querySelector(".sp-play");
  const speedBtn = hud.querySelector(".sp-speed");
  const zoomInput = hud.querySelector(".sp-zoom");
  const distOut = hud.querySelector(".sp-dist");
  const resetBtn = hud.querySelector(".sp-reset");
  const syncZoomUi = () => {
    zoomInput.value = String(Math.round(st.zoom * 1000));
    st.camDist = zoomToDistance(st.zoom, scene.zoomKm.min, scene.zoomKm.max);
    distOut.textContent = formatKm(st.camDist);
  };
  // A viewer touching zoom takes the camera off the launch scene's auto-dolly
  // for good — their control always wins over the scripted flight.
  const takeZoom = () => {
    st.autoZoom = false;
    syncZoomUi();
  };
  // …and while the dolly IS flying, the HUD tracks it.
  st.onCamDist = (d) => {
    st.zoom = distanceToZoom(d, scene.zoomKm.min, scene.zoomKm.max);
    zoomInput.value = String(Math.round(st.zoom * 1000));
    distOut.textContent = formatKm(d);
  };
  syncZoomUi();
  playBtn.addEventListener("click", () => {
    st.playing = !st.playing;
    playBtn.textContent = st.playing ? "⏸" : "▶";
  });
  const speeds = [1, 8, 64];
  speedBtn.addEventListener("click", () => {
    const i = (speeds.indexOf(st.speed) + 1) % speeds.length;
    st.speed = speeds[i];
    speedBtn.textContent = `×${st.speed}`;
  });
  zoomInput.addEventListener("input", () => {
    st.zoom = Number(zoomInput.value) / 1000;
    takeZoom();
  });
  resetBtn.addEventListener("click", () => {
    st.zoom = distanceToZoom(scene.zoomKm.start, scene.zoomKm.min, scene.zoomKm.max);
    st.rotX = scene.kind === "surface" ? 0.12 : scene.kind === "compare" ? 0.15 : 0.35;
    st.rotY = 0.5;
    st.time = 0; st.simDays = 0; st.u = 0;
    // Reset restores the scene as it was mounted — dolly included.
    if (scene.kind === "launch") st.autoZoom = true;
    syncZoomUi();
  });

  // --- pointer interaction: drag to rotate ----------------------------------
  // Rotation ONLY. The pinch used to be read from a second pointer here, and
  // on iOS that path never runs: WebKit treats a second finger as a page
  // gesture, fires `gesturestart` and CANCELS the pointers, so `pointers`
  // never reaches size 2. (`touch-action: none` does not help — iOS keeps
  // pinch-zoom available whatever the page asks, an accessibility decision.)
  // Reported as feedback #58 — "i cannot zoom by pinching", iPhone, iOS 18.7.
  // The pinch now lives on the touch/gesture handlers below, which are the
  // events that DO keep arriving; leaving a pointer-pair pinch beside them
  // would double-apply on Android, where both families fire.
  let pinchDist = 0;
  let pinching = false;
  const pointers = new Map();
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  });
  canvas.addEventListener("pointermove", (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    // One finger rotates; while two are down the gesture is a pinch and the
    // scene must not swing around under it.
    if (pointers.size === 1 && !pinching) {
      st.rotY += (cur.x - prev.x) * 0.006;
      st.rotX = clamp(st.rotX + (cur.y - prev.y) * 0.006, -1.35, 1.35);
    }
    pointers.set(e.pointerId, cur);
  });
  const drop = (e) => { pointers.delete(e.pointerId); };
  canvas.addEventListener("pointerup", drop);
  canvas.addEventListener("pointercancel", drop);

  // --- pinch to zoom: touch events, with WebKit's gestures as the backstop --
  /** @param {TouchList} t */
  const spread = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  canvas.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 2) return;
    pinching = true;
    pinchDist = spread(e.touches);
    e.preventDefault();
  }, { passive: false });
  canvas.addEventListener("touchmove", (e) => {
    if (e.touches.length < 2) return;
    // THIS is what stops the page zooming instead of the scene on iOS.
    e.preventDefault();
    const d = spread(e.touches);
    if (pinchDist > 0) {
      st.zoom = clamp(st.zoom - (d - pinchDist) * 0.0016, 0, 1);
      takeZoom();
    }
    pinchDist = d;
  }, { passive: false });
  const endPinch = (e) => {
    if (e.touches && e.touches.length >= 2) return;
    pinching = false;
    pinchDist = 0;
  };
  canvas.addEventListener("touchend", endPinch);
  canvas.addEventListener("touchcancel", endPinch);
  // WebKit's own gesture events, for the case where the fingers were routed
  // into a gesture and touchmove never saw the pair. Swallowed either way so
  // a pinch that lands on a scene cannot zoom the whole page instead.
  let gestureScale = 1;
  canvas.addEventListener("gesturestart", (e) => {
    e.preventDefault();
    gestureScale = e.scale || 1;
  });
  canvas.addEventListener("gesturechange", (e) => {
    e.preventDefault();
    if (pinchDist > 0) return; // touchmove is already driving it
    const s = e.scale || 1;
    if (gestureScale > 0) {
      st.zoom = clamp(st.zoom - Math.log(s / gestureScale) * 0.55, 0, 1);
      takeZoom();
    }
    gestureScale = s;
  });
  canvas.addEventListener("gestureend", (e) => {
    e.preventDefault();
    gestureScale = 1;
  });

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    // A trackpad pinch arrives as a ctrl-modified wheel, not as two pointers.
    const step = e.ctrlKey ? 0.05 : 0.02;
    st.zoom = clamp(st.zoom + Math.sign(e.deltaY) * step, 0, 1);
    takeZoom();
  }, { passive: false });

  // --- language-dependent text ----------------------------------------------
  const applyLang = () => {
    st.lang = lang;
    hint.textContent = UI.hint[lang];
    scaleNote.textContent = scaleNoteFor(scene)[lang];
    playBtn.title = UI.play[lang];
    if (caption) caption.textContent = scene.reply[lang];
    if (more) more.textContent = UI.more[lang];
  };
  applyLang();

  // --- visibility + loop registration ---------------------------------------
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) st.visible = e.isIntersecting;
  }, { rootMargin: "80px" });
  io.observe(stage);
  mounts.add(st);
  startLoop();

  return {
    el: wrap,
    state: st,
    setLang(l) {
      lang = l === "sv" ? "sv" : "en";
      applyLang();
    },
    destroy() {
      io.disconnect();
      mounts.delete(st);
      wrap.remove();
    },
  };
}
