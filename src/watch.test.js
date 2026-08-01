// The watch builder's server façade: the endpoint, not the catalogue.
//
// The catalogue, the compatibility rules and the geometry are the core's own
// suite (public/js/watch-core.test.js), and src/facade-contract.test.js already
// proves the re-exports here ARE the core's functions rather than copies. What
// is left, and what this file covers, is the HTTP surface: the four shapes
// GET /api/watch/catalog answers in, its caching, its 404s, and — the one that
// matters most — that it never reaches the network.

import { test, describe } from "node:test";
import { MOVEMENTS } from "./watch.js";
import assert from "node:assert/strict";

import { handleWatchCatalog, CASES, SLOTS, DEFAULT_BUILD, encodeBuild } from "./watch.js";

/** @param {string} qs */
const call = (qs) => handleWatchCatalog(new URL(`https://deepresearch.se/api/watch/catalog${qs}`));
/** @param {Response} r */
const body = (r) => r.json();

describe("GET /api/watch/catalog", () => {
  test("the bare call returns the whole pre-indexed catalogue", async () => {
    const res = call("");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /application\/json/);
    assert.equal(res.headers.get("cache-control"), "public, max-age=3600");
    const j = await body(res);
    assert.equal(j.cases.length, CASES.length);
    assert.equal(j.slots.length, SLOTS.length);
    assert.deepEqual(j.movement.handTubes, { hour: 1.5, minute: 0.9, second: 0.2 });
    assert.equal(j.movement.dialDia, 28.5);
    assert.ok(j.parts.dial.length > 0 && j.parts.hands.length > 0);
    assert.ok(j.brands.length > 0);
    assert.ok(j.sources.dlw && j.sources.dlw.url);
    assert.deepEqual(j.defaultBuild, DEFAULT_BUILD);
    // The honesty note travels with the payload, not just with the docs.
    assert.match(j.note, /approx/);
    assert.match(j.note, /never contacts aliexpress\.com/);
  });

  test("every case row carries dimensions, a source and buyable links", async () => {
    const j = await body(call(""));
    for (const c of j.cases) {
      assert.ok(c.dims.dia > 0 && c.dims.l2l > 0, c.id);
      assert.ok(c.src, `${c.id} has no source`);
      assert.ok(c.ali.links.length > 0, `${c.id} has no search links`);
      for (const l of c.ali.links) {
        assert.match(l.url, /^https:\/\/www\.aliexpress\.com\/w\/wholesale-[a-z0-9-]+\.html$/);
      }
    }
  });

  test("?case= narrows to one case and includes its platform", async () => {
    const j = await body(call("?case=skx007"));
    assert.equal(j.case.id, "skx007");
    assert.equal(j.case.dims.dia, 42.5);
    assert.equal(j.platform.id, "skx");
    assert.deepEqual(j.platform.insert, { od: 38, id: 31.8 });
    assert.ok(j.case.blurb.en && j.case.blurb.sv);
  });

  test("?case= with an unknown id 404s and says what exists", async () => {
    const res = call("?case=rolex-daytona");
    assert.equal(res.status, 404);
    const j = await res.json();
    assert.ok(Array.isArray(j.cases) && j.cases.includes("skx007"));
  });

  test("?slot= returns one parts family", async () => {
    const j = await body(call("?slot=dial"));
    assert.equal(j.slot, "dial");
    assert.ok(j.options.some((o) => o.id === "skx-black"));
  });

  test("?slot= with an unknown key 404s and lists the slots", async () => {
    const res = call("?slot=bezel");
    assert.equal(res.status, 404);
    const j = await res.json();
    assert.ok(j.slots.includes("insert"));
  });

  test("?build= answers the whole page's question without the page", async () => {
    const j = await body(call(`?build=${encodeURIComponent(encodeBuild(DEFAULT_BUILD))}`));
    assert.equal(j.build.case, "skx007");
    assert.equal(j.spec.caseDia, 42.5);
    assert.equal(j.fit.ok, true);
    assert.ok(j.sourcing.length >= 8);
    assert.equal(j.code, encodeBuild(DEFAULT_BUILD));
  });

  test("?build= reports an unbuildable combination rather than refusing it", async () => {
    // The endpoint mirrors the page's posture: an impossible build still
    // resolves, with the problems listed beside it.
    const bad = encodeBuild({ ...DEFAULT_BUILD, movement: "nh36", dial: "skx-black" });
    const res = call(`?build=${encodeURIComponent(bad)}`);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.fit.ok, false);
    assert.ok(j.fit.issues.some((i) => i.level === "error"));
    assert.ok(j.fit.issues.every((i) => i.en && i.sv));
  });

  test("a junk ?build= degrades to the default rather than erroring", async () => {
    for (const code of ["", "%%%", "case:nope", "a:b;c:d"]) {
      const res = call(`?build=${encodeURIComponent(code)}`);
      assert.equal(res.status, 200);
      const j = await res.json();
      for (const slot of SLOTS) assert.ok(j.build[slot.key], `${code}: ${slot.key} unfilled`);
    }
  });

  test("the endpoint never performs a fetch", async () => {
    // The AliExpress index is a curated SEARCH index, not a scrape: this
    // endpoint builds aliexpress.com URLs as strings and must never call one.
    // If that ever changes, a visitor's build starts leaving the server.
    const real = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = () => {
      calls += 1;
      throw new Error("the watch catalogue must not make outbound requests");
    };
    try {
      await body(call(""));
      await body(call("?case=62mas"));
      await body(call("?slot=hands"));
      await body(call(`?build=${encodeURIComponent(encodeBuild(DEFAULT_BUILD))}`));
    } finally {
      globalThis.fetch = real;
    }
    assert.equal(calls, 0);
  });

  test("the response carries no identity, cookie or account field", async () => {
    const res = call("");
    assert.equal(res.headers.get("set-cookie"), null);
    // Keys, not substrings: a source URL ending in "movement-guide" contains
    // "uid" and means nothing. What would matter is a FIELD named for a user.
    const forbidden = /^(email|session|uid|user|identity|account|cookie|token|ip)$/i;
    const walk = (v, path) => {
      if (!v || typeof v !== "object") return;
      if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
      for (const k of Object.keys(v)) {
        assert.ok(!forbidden.test(k), `payload carries a ${k} field at ${path}`);
        walk(v[k], `${path}.${k}`);
      }
    };
    walk(await res.json(), "$");
  });
});

// ---------------------------------------------------------------------------
// CASE AND DIAL GEOMETRY — the feedback-#56 half: whacky case models with
// floating lugs, a dial hanging inside a case you could see straight through,
// a "flat" sapphire that bulged, and a day wheel printed on top of the date.
//
// These are geometry assertions, so they go through the façade deliberately:
// the re-export IS the core (src/facade-contract.test.js pins that), so testing
// here also proves the endpoint's consumers get the fixed builders.

import {
  DIALS,
  CRYSTALS,
  // Aliased: the catalogue suite further down this file imports CROWNS too,
  // and two top-level bindings of one name is a SyntaxError.
  CROWNS as CROWN_STYLES,
  PLATFORMS,
  buildMeshes,
  caseProfile,
  crystalMesh,
  crystalFamily,
  dialLayout,
  layoutCollisions,
  outlineFor,
  flankRadiusAt,
  silhouetteZ,
  SHELL_ARCHETYPES,
  CRYSTAL_FAMILIES,
  DIAL_METRICS,
  SOURCES,
  movementDetail,
} from "./watch.js";

/** Triangles of a mesh as coordinate triples. */
function triangles(mesh) {
  /** @type {number[][][]} */
  const out = [];
  for (let i = 0; i < mesh.indices.length; i += 3) {
    /** @type {number[][]} */
    const p = [];
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[i + k] * 3;
      p.push([mesh.positions[v], mesh.positions[v + 1], mesh.positions[v + 2]]);
    }
    out.push(p);
  }
  return out;
}

/**
 * Möller–Trumbore. Returns null for a miss, otherwise `{ t, exiting }` — the
 * ray parameter and whether the ray left the solid through this face, read off
 * the triangle's winding (every builder here winds counter-clockwise seen from
 * outside).
 */
function rayHit(o, d, tri) {
  const [a, b, c] = tri;
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const p = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
  const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  const t0 = [o[0] - a[0], o[1] - a[1], o[2] - a[2]];
  const u = (t0[0] * p[0] + t0[1] * p[1] + t0[2] * p[2]) * inv;
  if (u < -1e-9 || u > 1 + 1e-9) return null;
  const q = [t0[1] * e1[2] - t0[2] * e1[1], t0[2] * e1[0] - t0[0] * e1[2], t0[0] * e1[1] - t0[1] * e1[0]];
  const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) * inv;
  if (v < -1e-9 || u + v > 1 + 1e-9) return null;
  const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv;
  if (!(t > 1e-7)) return null;
  const n = [
    e1[1] * e2[2] - e1[2] * e2[1],
    e1[2] * e2[0] - e1[0] * e2[2],
    e1[0] * e2[1] - e1[1] * e2[0],
  ];
  return { t, exiting: d[0] * n[0] + d[1] * n[1] + d[2] * n[2] > 0 };
}

/**
 * How many of a merged mesh's closed solids contain `pt` — a generalised
 * winding number, counting exits minus entries.
 *
 * Plain crossing PARITY, which the watertightness test uses, is the wrong tool
 * here: the case mesh is a union of overlapping solids (shell, bezel ring,
 * crown boss, crown guards) and a point inside two of them crosses an even
 * number of faces, reading as "outside".
 */
function solidDepth(pt, faces) {
  const raw = [0.3123, 0.8461, 0.4329];
  const L = Math.hypot(raw[0], raw[1], raw[2]);
  const d = raw.map((v) => v / L);
  let w = 0;
  for (const t of faces) {
    const h = rayHit(pt, d, t);
    if (h) w += h.exiting ? 1 : -1;
  }
  return w;
}

/** Vertices of a mesh as [x, y, z]. */
function verts(mesh) {
  /** @type {number[][]} */
  const out = [];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    out.push([mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]]);
  }
  return out;
}

const SOLIDS = ["case", "caseback", "movement", "lugs", "crown"];

describe("case and dial geometry", () => {
  test("the case is a CLOSED shell — no sightline passes through the metal", () => {
    // The report: "the dial just floats in the middle of the watch around
    // invisible walls meant only to be viewed from the outside — you can see
    // out of the case from the inside". The case was one lathed surface with no
    // inner wall and a case back that only reached 0.66 R, so the bottom of the
    // watch was an open annulus; the fragment shader's
    // `if (!gl_FrontFacing) N = -N;` was the only thing making the hole look
    // like a surface.
    //
    // A ray crossing a closed solid crosses its boundary an EVEN number of
    // times. An odd count is a hole, wherever it is and whichever way it faces.
    for (const c of CASES) {
      const r = buildMeshes({ ...DEFAULT_BUILD, case: c.id }, { segments: 16 });
      const tris = [];
      for (const n of SOLIDS) tris.push(...triangles(r.meshes[n]));
      const T = c.dims.thick;
      const R = c.dims.dia / 2;
      let checked = 0;
      for (let ai = 0; ai < 12; ai++) {
        const a = (ai / 12) * Math.PI * 2;
        for (const pitch of [0.03, 0.15, 0.4, -0.25]) {
          const o = [Math.cos(a) * 300, T * 0.5 + Math.sin(pitch) * 300, Math.sin(a) * 300];
          for (const aim of [
            [0, r.geo.dialY - 0.6, 0],
            [R * 0.5, r.geo.dialY + 0.2, 0],
            [0, r.geo.floorY + 0.3, R * 0.4],
          ]) {
            const d = [aim[0] - o[0], aim[1] - o[1], aim[2] - o[2]];
            const L = Math.hypot(d[0], d[1], d[2]);
            d[0] /= L;
            d[1] /= L;
            d[2] /= L;
            let count = 0;
            for (const t of tris) if (rayHit(o, d, t) !== null) count++;
            assert.equal(count % 2, 0, `${c.id}: a sightline crosses ${count} faces — the case has a hole`);
            checked++;
          }
        }
      }
      assert.equal(checked, 144);
    }
  });

  test("every solid is edge-closed, counted on positions rather than indices", () => {
    // The cheap standing guard behind the ray test: a watertight surface shares
    // every edge between an even number of triangles.
    for (const c of CASES.slice(0, 8)) {
      const r = buildMeshes({ ...DEFAULT_BUILD, case: c.id }, { segments: 24 });
      for (const name of [...SOLIDS, "crystal"]) {
        const m = r.meshes[name];
        const key = (i) =>
          [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]]
            .map((v) => Math.round(v * 1e4) / 1e4)
            .join(",");
        /** @type {Map<string, number>} */
        const edges = new Map();
        for (let t = 0; t < m.indices.length; t += 3) {
          const k = [key(m.indices[t]), key(m.indices[t + 1]), key(m.indices[t + 2])];
          for (let e = 0; e < 3; e++) {
            const a = k[e];
            const b = k[(e + 1) % 3];
            if (a === b) continue; // a pole ring collapses to a single point
            const id = a < b ? `${a}|${b}` : `${b}|${a}`;
            edges.set(id, (edges.get(id) || 0) + 1);
          }
        }
        for (const [id, n] of edges) {
          assert.equal(n % 2, 0, `${c.id}/${name}: edge ${id} is shared by ${n} triangles`);
        }
      }
    }
  });

  test("the case has a real bore and the case back plugs it", () => {
    for (const c of CASES) {
      const geo = caseProfile(c, CRYSTALS[0]);
      const rs = geo.profile.map((p) => p.r);
      assert.ok(Math.min(...rs) > 0, `${c.id}: the profile still runs to the axis — that is a bowl, not a shell`);
      const first = geo.profile[0];
      const last = geo.profile[geo.profile.length - 1];
      assert.ok(
        Math.abs(first.r - last.r) < 1e-9 && Math.abs(first.y - last.y) < 1e-9,
        `${c.id}: the cross-section does not close`,
      );
      assert.ok(geo.boreR > geo.dialR, `${c.id}: the bore does not clear the dial`);
      assert.ok(geo.boreBotR > geo.boreR, `${c.id}: the case-back recess is not wider than the bore`);
      assert.ok(geo.floorY > 0 && geo.floorY < geo.dialY, `${c.id}: the interior floor is not under the dial`);
      // The back CLOSES the bore; the interior FILLS it. They are two meshes
      // (the interior has its own materials once a display back makes it
      // visible), so each is asserted where it actually lives — the version of
      // this that read `backTop` off a merged caseback would pass on an
      // interior that had quietly stopped being built.
      const meshes = buildMeshes({ ...DEFAULT_BUILD, case: c.id }, { segments: 16 }).meshes;
      const back = verts(meshes.caseback);
      const backR = Math.max(...back.map((p) => Math.hypot(p[0], p[2])));
      const inside = verts(meshes.movement);
      const insideTop = Math.max(...inside.map((p) => p[1]));
      assert.ok(backR >= geo.boreBotR - 1e-6, `${c.id}: the case back is narrower than the bore it has to close`);
      assert.ok(insideTop >= geo.dialY - 1, `${c.id}: nothing fills the case under the dial`);
    }
  });

  test("the six shell archetypes are genuinely different silhouettes", () => {
    // "Case models very whacky — most look the same." They shared one set of
    // profile ratios; only the PLAN outline differed, and three of the six
    // archetypes are round in plan, so a dress case and a diver drew one flank.
    /** @type {Map<string, string>} */
    const sigs = new Map();
    for (const [id, arch] of Object.entries(SHELL_ARCHETYPES)) {
      const pts = arch.flank(10, 10, { slim: 0.5, beefy: 0.5, reach: 0.5 });
      const sig = pts.map((p) => `${p.r.toFixed(3)}@${p.y.toFixed(3)}${p.s ? "s" : ""}`).join(" ");
      assert.ok(!sigs.has(sig), `${id} and ${sigs.get(sig)} draw the same flank`);
      sigs.set(sig, id);
      assert.ok(arch.topF > arch.seatF, `${id}: the bezel top must be above its seat`);
    }
    assert.equal(sigs.size, 6);
  });

  test("two cases that differ in the catalogue differ in the render", () => {
    const signature = (m) =>
      m.positions.filter((_, i) => i % 37 === 0).map((v) => Math.round(v * 100)).join(",") +
      `|${m.positions.length}`;
    /** @type {Map<string, string>} */
    const seen = new Map();
    for (const c of CASES) {
      const r = buildMeshes({ ...DEFAULT_BUILD, case: c.id }, { segments: 24 });
      const sig = signature(r.meshes.case) + signature(r.meshes.lugs) + JSON.stringify(r.crownTransform);
      assert.ok(!seen.has(sig), `${c.id} renders identically to ${seen.get(sig)}`);
      seen.set(sig, c.id);
    }
    assert.equal(seen.size, CASES.length);
  });

  test("lugs start inside the flank, end at the catalogue's lug-to-lug, and taper to a rounded tip", () => {
    // The floating parts: four axis-aligned boxes starting at a flat 0.8 R,
    // which on any non-round silhouette left the block hanging beside the case.
    for (const c of CASES) {
      const geo = caseProfile(c, CRYSTALS[0]);
      const outline = outlineFor(c.shell);
      const lug = verts(buildMeshes({ ...DEFAULT_BUILD, case: c.id }, { segments: 24 }).meshes.lugs);
      const pos = lug.filter((p) => p[2] > 0);
      const zRoot = Math.min(...pos.map((p) => p[2]));
      const zTip = Math.max(...pos.map((p) => p[2]));
      const xMax = Math.max(...pos.map((p) => Math.abs(p[0])));
      assert.ok(Math.abs(zTip - c.dims.l2l / 2) < 1e-6, `${c.id}: the lug tip is not at the catalogue's lug-to-lug`);
      const surface = silhouetteZ(xMax, flankRadiusAt(geo.outer, c.dims.thick * 0.37), outline);
      assert.ok(
        zRoot < surface - 0.5,
        `${c.id}: the lug root sits at z=${zRoot} but the flank is at ${surface} — it would float`,
      );
      // The lug is swept in discrete sections, so measure the y-span over a
      // band wide enough to hold one — a hairline slice would find nothing.
      const len = zTip - zRoot;
      const spanAt = (f) => {
        const lo = zRoot + len * f - len * 0.09;
        const hi = zRoot + len * f + len * 0.09;
        const band = pos.filter((p) => p[2] >= lo && p[2] <= hi);
        return band.length ? Math.max(...band.map((p) => p[1])) - Math.min(...band.map((p) => p[1])) : 0;
      };
      const body = spanAt(0.5);
      assert.ok(body > 0.5, `${c.id}: the lug has no body`);
      assert.ok(spanAt(1) < body * 0.75, `${c.id}: the lug tip is a square block, not a rounded drilled-lug end`);
      const tipSpan = Math.max(
        ...pos.filter((p) => p[2] > zTip - 1e-6).map((p) => p[1]),
      ) - Math.min(...pos.filter((p) => p[2] > zTip - 1e-6).map((p) => p[1]));
      assert.ok(tipSpan < body * 0.15, `${c.id}: the very end of the lug is not rounded off`);
    }
  });

  test("the crown is knurled, sits against the flank, and only guarded cases get guards", () => {
    for (const c of CASES) {
      const r = buildMeshes({ ...DEFAULT_BUILD, case: c.id }, { segments: 32 });
      const crown = verts(r.meshes.crown);
      // The barrel's radius varies around its circumference — modelled flutes,
      // not a smooth lathed cylinder with a texture painted on.
      const barrelR = Math.max(...crown.map((p) => Math.hypot(p[0], p[2])));
      const radii = crown
        .map((p) => Math.hypot(p[0], p[2]))
        .filter((v) => v > barrelR * 0.85);
      assert.ok(radii.length > 20, `${c.id}: no crown barrel`);
      assert.ok(
        Math.max(...radii) - Math.min(...radii) > 0.02,
        `${c.id}: the crown is a smooth barrel — no modelled knurling`,
      );
      // The tube reaches into the flank, so nothing hovers beside the case.
      const reach = Math.max(...crown.map((p) => p[1]));
      const out = Math.hypot(r.crownTransform.x, r.crownTransform.z);
      const flank = flankRadiusAt(r.geo.outer, r.geo.crownY) * outlineFor(c.shell)(r.crownTransform.angle);
      assert.ok(out - reach <= flank + 1e-6, `${c.id}: the crown stops ${out - reach - flank} mm short of the flank`);
      assert.ok(barrelR > 0.9, `${c.id}: the crown has no grip`);
    }
    // Guards are CASE geometry, so a guarded case and its no-guard sibling —
    // same shell, same platform, same millimetres — cannot draw the same case.
    const guarded = buildMeshes({ ...DEFAULT_BUILD, case: "skx007" }, { segments: 24 });
    const bare = buildMeshes({ ...DEFAULT_BUILD, case: "skx-ncg" }, { segments: 24 });
    assert.ok(
      guarded.meshes.case.positions.length > bare.meshes.case.positions.length,
      "crown guards are not modelled",
    );
  });

  test("the crown MEETS the case on every shell archetype and every crown style", () => {
    // The regression this pins, found in a headless-Chromium render: on the
    // shroud shell the crown floated clear of the case with daylight behind
    // it. Two causes, both invisible to a check that only looked at the SKX.
    //
    //   1. The crown was seated at the flank's widest POINT. On a stepped
    //      flank that point is a corner — the Tuna's shroud lip — so the flank
    //      across the crown's own footprint ran 19.8 → 23.3 mm and the barrel
    //      hung over the undercut. It now seats on the widest PLATEAU.
    //   2. A flank curves away above and below wherever the crown sits, so a
    //      barrel can only ever kiss it along one line. The case now carries a
    //      crown BOSS, the tube collar a real case is machined with.
    //
    // The assertion is per-shell and mesh-driven: sample the crown's own inner
    // surface across its footprint and require every sample to be inside the
    // case solid. Against the previous geometry this reports 50 gaps.
    for (const c of CASES) {
      for (const crown of CROWN_STYLES) {
        const r = buildMeshes({ ...DEFAULT_BUILD, case: c.id, crown: crown.id }, { segments: 64 });
        const faces = triangles(r.meshes.case);
        const geo = r.geo;
        const out = Math.hypot(r.crownTransform.x, r.crownTransform.z);
        const ca = Math.cos(geo.crownAngle);
        const sa = Math.sin(geo.crownAngle);
        const crownH = geo.crownR * (crown.style === "onion" ? 2.1 : crown.style === "fluted" ? 1.7 : 1.85);
        // The barrel's inner face — the part that has to find metal.
        const face = out - crownH / 2;
        for (let s = -3; s <= 3; s++) {
          const dy = (geo.crownR * 0.62 * s) / 3;
          for (const dz of [-geo.crownR * 0.5, 0, geo.crownR * 0.5]) {
            const pt = [face * ca - dz * sa, geo.crownY + dy, face * sa + dz * ca];
            assert.ok(
              solidDepth(pt, faces) > 0,
              `${c.id}/${crown.id}: the crown floats — its inner face at height ${geo.crownY + dy} is outside the case`,
            );
          }
        }
        // And the seat itself: the flank must not fall away underneath the
        // crown's footprint, which is the condition the shroud violated.
        const k = outlineFor(c.shell)(geo.crownAngle);
        for (let s = -2; s <= 2; s++) {
          const y = geo.crownY + (geo.crownR * s) / 2;
          assert.ok(
            flankRadiusAt(geo.outer, y) * k >= geo.crownFlank - 1e-9,
            `${c.id}: the seat's flank minimum is not the minimum across the crown's footprint`,
          );
        }
        assert.ok(geo.crownY > 0 && geo.crownY < geo.bezelSeatY, `${c.id}: the crown fouls the bezel`);
      }
    }
  });

  test("the lug tip ends at the catalogue's lug-to-lug and publishes where a strap meets it", () => {
    for (const c of CASES) {
      const r = buildMeshes({ ...DEFAULT_BUILD, case: c.id }, { segments: 24 });
      const tipZ = Math.max(...verts(r.meshes.lugs).map((p) => p[2]));
      assert.ok(Math.abs(tipZ - c.dims.l2l / 2) < 1e-6, `${c.id}: the lug tip is not at lug-to-lug/2`);
      // The spring bar sits at the centre of the rounded tip, INBOARD of it —
      // a strap that starts at the tip itself starts past the lug.
      const a = r.strapAnchor;
      assert.ok(a.z < tipZ && a.z > tipZ - 3, `${c.id}: the strap anchor is not in the lug's rounded end`);
      assert.equal(a.width, c.dims.lugW, `${c.id}: the anchor is not the catalogue's lug width`);
      assert.ok(a.y > 0 && a.y < c.dims.thick * 0.5, `${c.id}: the anchor is not on the lug's axis`);
      assert.ok(a.thickness > 0.4 && a.thickness < c.dims.thick, `${c.id}: implausible lug thickness`);
    }
  });

  test("a flat crystal is FLAT, and the four families are different solids", () => {
    // "Flat sapphire isn't flat": every crystal was one spherical cap with a
    // scaled height, so `dome: 0.15` still bulged and a box crystal was just a
    // taller dome.
    const shape = (fam) => {
      const v = verts(crystalMesh(15, 10, 3, 48, fam));
      const top = Math.max(...v.map((p) => p[1]));
      const bottom = Math.min(...v.map((p) => p[1]));
      const flatR = Math.max(
        0,
        ...v.filter((p) => Math.abs(p[1] - top) < 1e-6).map((p) => Math.hypot(p[0], p[2])),
      );
      // How vertical the wall is: how much radius survives into the top half.
      const wall = Math.max(
        ...v.filter((p) => p[1] >= 10 + 3 * 0.5).map((p) => Math.hypot(p[0], p[2])),
      );
      return { top, bottom, flatR, wall };
    };
    const flat = shape("flat");
    const dome = shape("dome");
    const dbl = shape("double");
    const boxy = shape("box");
    for (const [id, s] of /** @type {[string, any][]} */ ([["flat", flat], ["dome", dome], ["double", dbl], ["box", boxy]])) {
      assert.ok(Math.abs(s.top - 13) < 1e-6, `${id}: top`);
      assert.ok(Math.abs(s.bottom - 10) < 1e-6, `${id}: base`);
    }
    assert.ok(flat.flatR > 15 * 0.9, `a flat crystal's top face must be flat, not a cap (got ${flat.flatR}/15)`);
    assert.ok(boxy.flatR > 15 * 0.9, "a box crystal has a flat top");
    assert.ok(dome.flatR < 1e-6, "a single dome comes to an apex");
    assert.ok(dbl.flatR < 1e-6, "a double dome comes to an apex");
    // A box and a flat crystal still have their full radius halfway up — the
    // walls are vertical. Both domes have already curved in by then.
    assert.ok(boxy.wall > 15 * 0.99, `a box crystal has near-vertical walls (got ${boxy.wall}/15)`);
    assert.ok(flat.wall > 15 * 0.99, "a flat crystal has a vertical edge, not a slope");
    assert.ok(dome.wall < 15 * 0.95, "a single dome has curved in by half its height");
    assert.ok(dbl.wall < 15 * 0.95, "a double dome has curved in by half its height");
    // The four choices are visibly different heights on the same case, which is
    // what makes picking one mean anything.
    const skx = CASES.find((c) => c.id === "skx007");
    const h = (id) => caseProfile(skx, CRYSTALS.find((c) => c.id === id)).domeH;
    assert.ok(h("box-sapphire") > h("dd-sapphire"));
    assert.ok(h("dd-sapphire") > h("flat-sapphire"));
    // "domed-hardlex" is a FLAT crystal despite its id. The stock SKX mineral
    // crystal is flat — which is the whole reason a double-dome sapphire is the
    // standard upgrade — so the catalogue calls it "Flat Hardlex (stock)". The
    // id keeps its old spelling only so existing permalinks still decode.
    assert.equal(crystalFamily(CRYSTALS.find((c) => c.id === "domed-hardlex")), "flat");
    assert.equal(crystalFamily(CRYSTALS.find((c) => c.id === "flat-sapphire")), "flat");
    assert.equal(crystalFamily(CRYSTALS.find((c) => c.id === "box-sapphire")), "box");
    assert.equal(crystalFamily(null), "dome");
  });

  test("the day-date aperture is ONE cut, sized off the NH36A drawing, day inboard", () => {
    // "Day clips into date on day-date models." Both apertures were driven off
    // dial.date/dial.day and painted as overlapping rectangles. The dial is cut
    // ONCE (NH36A sheet p8: 7.00 × 2.00 mm at 8.45 mm); what reads as a divider
    // is the day disc's outer edge over the date ring.
    const A = DIAL_METRICS.aperture;
    const dd = dialLayout(DIALS.find((d) => d.id === "daydate-black"), 14.25);
    assert.equal(dd.apertures.length, 1, "a day-date dial is cut once, not twice");
    const cut = dd.apertures[0];
    assert.equal(cut.kind, "daydate");
    assert.ok(Math.abs(cut.mmW - A.dayDate.width) < 1e-9, "the cut is not the drawing's width");
    assert.ok(Math.abs(cut.mmH - A.height) < 1e-9, "the cut is not the drawing's height");
    assert.ok(Math.abs(cut.r * 14.25 - A.dayDate.centre) < 1e-9, "the cut is not where the drawing puts it");

    const day = cut.cells.find((c) => c.kind === "day");
    const date = cut.cells.find((c) => c.kind === "date");
    assert.ok(day && date, "both wheels must be placed");
    assert.ok(day.r < date.r, "the day disc reads INBOARD of the date — the drawing's own proof");
    const gap = (date.r - date.w / 2) - (day.r + day.w / 2);
    assert.ok(gap > 0, `the day and date cells overlap by ${-gap} of the dial radius`);
    assert.ok(day.mmW > date.mmW, "the day cell is the wider of the two (roughly 5:4)");
    // Every cell stays inside the one cut, and they tile it exactly.
    assert.ok(day.r - day.w / 2 >= cut.r - cut.w / 2 - 1e-9, "the day cell escapes the cut");
    assert.ok(date.r + date.w / 2 <= cut.r + cut.w / 2 + 1e-9, "the date cell escapes the cut");
    assert.ok(Math.abs(day.w + date.w + gap - cut.w) < 1e-9, "the cells do not tile the cut");
    // The NH36 date cell sits a couple of tenths inboard of the NH35's window,
    // which is the "date prints slightly left" effect modders report.
    assert.ok(date.r * 14.25 < A.date.centre, "the NH36 date should read just inboard of the NH35's");
    assert.ok(A.date.centre - date.r * 14.25 < 0.5, "…but only by a couple of tenths");
    // Both cuts share an outer edge, to within the drawings' own 0.05 mm.
    const one = dialLayout(DIALS.find((d) => d.id === "skx-black"), 14.25);
    assert.equal(one.apertures.length, 1);
    assert.equal(one.apertures[0].kind, "date");
    assert.equal(one.apertures[0].cells.length, 1);
    const outerDay = (cut.r + cut.w / 2) * 14.25;
    const outerDate = (one.apertures[0].r + one.apertures[0].w / 2) * 14.25;
    assert.ok(Math.abs(outerDay - outerDate) < 0.06, "the two cutouts must share an outer edge");
  });

  test("no dial feature overlaps another or falls outside the dial, on any case", () => {
    // The "search for similar issues" half of the report, as an assertion:
    // markers, the minute track, the aperture, the GMT track, the open-heart
    // cut-out, the logo and every printed line, over every case × every dial.
    let combos = 0;
    for (const c of CASES) {
      const geo = caseProfile(c, CRYSTALS[0]);
      for (const d of DIALS) {
        const l = dialLayout(d, geo.dialR, { apertureR: geo.apertureR });
        assert.deepEqual(layoutCollisions(l), [], `${c.id} × ${d.id}`);
        combos++;
      }
    }
    assert.equal(combos, CASES.length * DIALS.length);
  });

  test("markers give way to an aperture by geometry, whatever the marker style", () => {
    // The old rule hardcoded "skip hour 3" and then exempted the Grand-Seiko
    // style from its own skip, which printed a facet marker under the date.
    const gs = DIALS.find((d) => d.id === "gs-white");
    assert.equal(dialLayout(gs, 14.25).markers.length, 12, "a no-date GS dial keeps all twelve");
    const gsDated = dialLayout({ ...gs, date: "3" }, 14.25);
    assert.ok(!gsDated.markers.some((m) => m.hour === 3), "a dated GS dial must give up the 3 marker too");
    // A date at another hour takes the skip with it rather than always taking 3.
    const atSix = dialLayout({ ...gs, date: "6" }, 14.25);
    assert.ok(!atSix.markers.some((m) => m.hour === 6));
    assert.ok(atSix.markers.some((m) => m.hour === 3));
  });

  test("the GMT track clears the markers, drops the numeral under the date, and the hand reaches it", () => {
    const l = dialLayout(DIALS.find((d) => d.id === "gmt-black"), 14.25);
    assert.ok(l.gmtTrack, "a GMT dial has a 24-hour track");
    assert.equal(l.gmtTrack.numerals.length, 12);
    assert.equal(
      l.gmtTrack.numerals.find((n) => n.value === 6).skipped,
      true,
      "the 24-hour numeral at 3 o'clock sits under the date window",
    );
    assert.equal(l.gmtTrack.numerals.filter((n) => n.skipped).length, 1, "only the one under the cut is dropped");
    assert.ok(
      l.gmtTrack.r + l.gmtTrack.half < Math.min(...l.markers.map((m) => m.rInner)),
      "the GMT track runs into the hour markers",
    );
    // The hand points AT its own scale instead of overshooting into the markers.
    const r = buildMeshes({ ...DEFAULT_BUILD, movement: "nh34", dial: "gmt-black", hands: "gmt-arrow" }, { segments: 16 });
    const tip = Math.max(...verts(r.hands.find((h) => h.id === "gmt").mesh).map((p) => Math.hypot(p[0], p[2])));
    assert.ok(tip <= l.gmtTrack.handTip * r.dialR + 1e-6, "the GMT hand overshoots its own scale");
    assert.ok(tip > l.gmtTrack.r * r.dialR, "the GMT hand does not reach its own scale");
  });

  test("a printed numeral is shrunk to fit its hour slot instead of running into its neighbour", () => {
    const roman = dialLayout(DIALS.find((d) => d.id === "salmon"), 14.25);
    assert.ok(roman.markers.find((m) => m.hour === 8).fit < 1, "VIII is wider than an hour slot and must scale to fit");
    const bar = dialLayout(DIALS.find((d) => d.id === "skx-black"), 14.25).markers.find((m) => m.hour === 6);
    assert.equal(bar.fit, 1, "a bar marker is never scaled");
  });

  test("nothing is printed under the case lip when the crystal is smaller than the dial", () => {
    // The SKX013 platform puts a 27.5 mm crystal over a 28.5 mm dial, so part of
    // the dial is under the case. The rehaut used to be built dial→crystal and
    // inverted itself on exactly those platforms.
    const c = CASES.find((x) => x.id === "skx013");
    const geo = caseProfile(c, CRYSTALS[0]);
    assert.ok(geo.apertureR < geo.dialR, "this case's opening is smaller than its dial");
    const l = dialLayout(DIALS.find((d) => d.id === "skx-black"), geo.dialR, { apertureR: geo.apertureR });
    assert.ok(l.visible < 1);
    for (const m of l.markers) assert.ok(m.rOuter <= l.visible + 1e-9, `marker ${m.hour} is under the case lip`);
    const rr = verts(buildMeshes({ ...DEFAULT_BUILD, case: "skx013" }, { segments: 16 }).meshes.chapterRing)
      .map((p) => Math.hypot(p[0], p[2]));
    assert.ok(Math.max(...rr) > Math.min(...rr) + 0.3, "the rehaut collapsed or inverted");
    assert.ok(Math.max(...rr) <= geo.apertureR + 1e-6, "the rehaut runs past the opening");
  });

  test("every new dimension names a source and says whether it is approximate", () => {
    for (const [id, fam] of Object.entries(CRYSTAL_FAMILIES)) {
      assert.ok(fam.thick > 0 && fam.proudF > 0 && fam.proudF < 1, `${id}: implausible crystal figures`);
      assert.ok(SOURCES[fam.src], `${id} cites the unknown source ${fam.src}`);
      assert.equal(typeof fam.approx, "boolean", `${id} does not say whether it is approximate`);
      assert.ok(fam.name.en && fam.name.sv, `${id} name is not bilingual`);
      assert.ok(fam.note && fam.note.en && fam.note.sv, `${id} note is not bilingual`);
    }
    // The cutout comes off a manufacturer drawing, so it is NOT approximate…
    const A = DIAL_METRICS.aperture;
    assert.equal(A.approx, false);
    assert.ok(SOURCES[A.src] && SOURCES[A.date.src] && SOURCES[A.dayDate.src]);
    assert.ok(A.note.en && A.note.sv);
    assert.deepEqual([A.height, A.date.width, A.date.centre], [2.0, 2.9, 10.55]);
    assert.deepEqual([A.dayDate.width, A.dayDate.centre], [7.0, 8.45]);
    // …while how the two DISCS divide it was measured off a photo, so it is.
    assert.equal(DIAL_METRICS.cells.approx, true);
    assert.ok(SOURCES[DIAL_METRICS.cells.src]);
    assert.ok(
      Math.abs(DIAL_METRICS.cells.day + DIAL_METRICS.cells.gap + DIAL_METRICS.cells.date - 1) < 1e-9,
      "the cell fractions must tile the cut exactly",
    );
    assert.equal(DIAL_METRICS.approx, true, "the remaining layout ratios are modelling numbers, not measurements");
    assert.equal(DIAL_METRICS.dialDia, 28.5, "the drawings quote everything on a Ø28.50 dial");
    for (const key of ["longisland", "watchmodz", "luciusatelier", "crystaltimesct094", "nh35sheet", "nh36sheet", "srpd55"]) {
      assert.ok(SOURCES[key] && SOURCES[key].label && SOURCES[key].url.startsWith("https://"), key);
    }
  });

  test("the geometry builders make no outbound request", () => {
    // The same promise the endpoint carries, held one layer down: assembling a
    // watch is arithmetic over committed data and nothing else.
    const real = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("the watch geometry must not make outbound requests");
    };
    try {
      for (const c of CASES.slice(0, 4)) buildMeshes({ ...DEFAULT_BUILD, case: c.id }, { segments: 12 });
      for (const d of DIALS) dialLayout(d, 14.25);
      assert.ok(PLATFORMS.skx);
    } finally {
      globalThis.fetch = real;
    }
  });
});

// ---------------------------------------------------------------------------
// The RENDERER's material table (public/js/watch-materials.js).
//
// The renderer itself cannot be loaded here — it needs a WebGL context — but
// the question feedback #56 actually asked ("leather shouldn't be shiny like a
// mirror surface", "lighting looks odd, especially for bezel inserts") is a
// question about a lookup table, and a lookup table is testable. What these
// pin is the PHYSICAL SPLIT: a conductor's specular is coloured and strong, a
// dielectric's is neutral and a few percent, and no resolver can put a strap
// on the wrong side of that line. The look itself still has to be judged in a
// browser; these stop it regressing back into one shared response.

import {
  ANISO_AXIAL,
  ANISO_CIRCUMFERENTIAL,
  ANISO_GRAIN,
  ANISO_KNURL,
  ANISO_NONE,
  ANISO_RADIAL,
  DEFAULT_COLORS,
  FALLBACK_MATERIAL,
  MATERIALS,
  crystalMaterial,
  dialMaterialId,
  dialRelief,
  finishMaterialId,
  insertMaterialId,
  lobeEnergy,
  markerIsApplied,
  materialFor,
  meshMaterialId,
  softboxEnergy,
  strapMaterialId,
  tintedF0,
} from "../public/js/watch-materials.js";
import { INSERTS, STRAPS, FINISHES } from "./watch.js";

const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const MODES = [ANISO_NONE, ANISO_CIRCUMFERENTIAL, ANISO_AXIAL, ANISO_RADIAL, ANISO_KNURL, ANISO_GRAIN];

describe("watch materials: the table itself", () => {
  test("every entry is in range and says why it is what it is", () => {
    for (const [id, m] of Object.entries(MATERIALS)) {
      assert.ok(m.rough > 0 && m.rough <= 1, `${id} roughness`);
      assert.ok(m.metal >= 0 && m.metal <= 1, `${id} metalness`);
      assert.ok(m.reflect > 0 && m.reflect <= 1, `${id} reflectance`);
      assert.ok((m.aniso || 0) >= 0 && (m.aniso || 0) <= 0.95, `${id} anisotropy`);
      assert.ok(MODES.indexOf(m.anisoMode || 0) >= 0, `${id} brush mode`);
      assert.ok([0, 1, 2].indexOf(m.axis || 0) >= 0, `${id} axis`);
      assert.ok((m.env === undefined ? 0.25 : m.env) <= 1, `${id} env`);
      assert.ok(typeof m.note === "string" && m.note.length > 20, `${id} note`);
    }
  });

  test("conductors reflect a lot and colour it; dielectrics reflect a little and do not", () => {
    for (const [id, m] of Object.entries(MATERIALS)) {
      // 0.2 is the line tintedF0 itself draws: above it a material's specular
      // is tinted by its own colour, below it the specular is white. The two
      // partial metals here (anodised aluminium, the metallic dial finishes)
      // are films OVER metal and belong on the conductor side of that line.
      if (m.metal >= 0.2) {
        assert.ok(m.reflect >= 0.15, `${id} is a metal but barely reflects`);
      } else if (!m.glass) {
        // The whole leather-is-not-a-mirror fix: a dielectric's F0 is a few
        // percent. Anything above 0.09 is a metal wearing a costume.
        assert.ok(m.reflect <= 0.09, `${id} is a dielectric with a metal's F0`);
      }
    }
  });

  test("no rough dielectric picks up the environment the way a bezel does", () => {
    // A metal's `env` is not glossiness — the shader blurs the environment by
    // roughness before it gets there, which is exactly why bead-blasted steel
    // can keep env near 1 and still look like sandpaper. For a DIELECTRIC it
    // is glossiness, and a rough one having it is the bug feedback #56
    // reported: a leather strap mirroring the room like a polished case.
    for (const [id, m] of Object.entries(MATERIALS)) {
      if (m.glass || m.metal >= 0.2 || m.rough < 0.4) continue;
      const env = m.env === undefined ? 0.25 : m.env;
      assert.ok(env <= 0.2, `${id} is a rough dielectric and must stay matte`);
    }
  });

  test("leather is matte, suede is nearly pure diffuse, and neither is a mirror", () => {
    const leather = MATERIALS.leather;
    assert.equal(leather.metal, 0);
    assert.ok(leather.rough >= 0.4, "smooth calf still has to read as matte");
    assert.ok(leather.env <= 0.1, "leather must not pick up the environment");
    assert.ok(leather.sheen > 0, "what gloss leather has is sheen, not reflection");
    const suede = MATERIALS["leather-suede"];
    assert.ok(suede.rough > leather.rough && suede.env < leather.env);
    assert.ok(suede.sheen > leather.sheen, "nap is mostly sheen");
  });

  test("a ceramic insert and an anodised aluminium one are not the same material", () => {
    const c = MATERIALS.ceramic;
    const a = MATERIALS["aluminium-anodised"];
    assert.ok(c.rough < 0.15, "ceramic is glossy");
    assert.ok(a.rough > 0.3, "anodised aluminium is semi-matte");
    assert.ok(a.rough - c.rough > 0.25, "the two must be visibly different");
    assert.ok(c.env > a.env, "ceramic shows the room; anodising does not");
    assert.equal(c.metal, 0, "ceramic is a dielectric, not the old half-metal");
  });

  test("the finishes that are brushed carry a direction, and blasting carries none", () => {
    assert.equal(MATERIALS["steel-brushed"].anisoMode, ANISO_CIRCUMFERENTIAL);
    assert.equal(MATERIALS["bracelet-brushed"].anisoMode, ANISO_CIRCUMFERENTIAL);
    assert.equal(MATERIALS["bracelet-brushed"].axis, 1, "a bracelet is brushed along the band, not around the case");
    assert.equal(MATERIALS["steel-blasted"].anisoMode, ANISO_GRAIN);
    assert.ok(!MATERIALS["steel-blasted"].aniso, "bead blasting has no preferred direction");
    // A crown's teeth are MODELLED (watch-core.js knurls the lathe), so the
    // material only supplies the direction they are finished in plus a fine
    // machining texture — anything with a groove amplitude near a real flute's
    // would beat against the geometry.
    for (const id of ["crown-knurled", "crown-fluted"]) {
      assert.equal(MATERIALS[id].anisoMode, ANISO_KNURL, id);
      assert.ok(MATERIALS[id].grain <= 0.05, `${id} must not re-cut the modelled flutes`);
      assert.ok(MATERIALS[id].grainFreq >= 60, `${id} machining texture must be finer than any flute pitch`);
      assert.ok(MATERIALS[id].aniso > 0.4, `${id} highlight stretches along the tooth`);
    }
  });

  test("a sunburst dial is direction, not paint and not relief", () => {
    const s = MATERIALS["dial-sunburst"];
    assert.equal(s.anisoMode, ANISO_RADIAL);
    assert.ok(s.aniso > 0.5, "the sweeping bar IS the anisotropy");
    assert.equal(dialRelief({ finish: "sunburst" }).pattern, "none");
    assert.equal(dialRelief({ finish: "sunburst" }).anisotropy, "radial");
  });
});

describe("watch materials: blurring a light must move energy, not add it", () => {
  // The regression these exist for: a real-browser check of the first version
  // of this renderer showed a brushed steel bracelet as flat white against a
  // correctly-grey case. Both causes were energy being invented — the softbox
  // widening with roughness without dimming, and each analytic light being a
  // delta source whose GGX peak is unbounded on a flat face. The formulas are
  // mirrored inline in the fragment shader, which cannot import them.
  test("a softbox dims as the square of how far it is blurred", () => {
    assert.equal(softboxEnergy(0.3, 0.3), 1, "unblurred is unchanged");
    assert.ok(Math.abs(softboxEnergy(0.3, 0.6) - 0.25) < 1e-9, "twice as wide is a quarter as bright");
    assert.ok(softboxEnergy(0.3, 0.85) < 0.13, "a fully rough surface sees almost none of it");
    // Monotone, and never a gain — the whole point.
    let prev = 2;
    for (let hw = 0.3; hw <= 0.9; hw += 0.05) {
      const e = softboxEnergy(0.3, hw);
      assert.ok(e <= 1 && e <= prev + 1e-12, `hw=${hw} gained energy`);
      prev = e;
    }
    assert.equal(softboxEnergy(0.3, 0), 1, "a degenerate width cannot divide by zero");
  });

  test("widening a lobe to its source caps the peak without adding light", () => {
    // A surface rougher than the source is untouched — which is why leather,
    // rubber and nylon in the same frame were never the problem and must not
    // move now.
    assert.equal(lobeEnergy(0.36, 0.36, 0.25), 1, "leather's lobe is already wider than the softbox");
    assert.equal(lobeEnergy(0.27, 0.27, 0.25), 1, "rubber likewise");
    // The bracelet: rough 0.30 brushed, so the across-grain axis is very
    // narrow and the peak is what blew out.
    const a = 0.3 * 0.3;
    const at = a * 1.72;
    const ab = a * 0.28;
    const e = lobeEnergy(at, ab, 0.25);
    assert.ok(e < 0.1, `brushed steel's peak must come down hard, got ${e}`);
    // Peak radiance after widening = D(widened) * energy. It has to be finite
    // and small enough to survive a 2.5-bright key without clipping.
    const peak = (1 / (Math.PI * Math.max(at, 0.25) * Math.max(ab, 0.25))) * e;
    assert.ok(peak < 1.0, `capped peak ${peak}`);
    // A mirror gets essentially nothing from the analytic light: its
    // highlight is the environment's reflected softbox, which carries the
    // source's real radiance.
    assert.ok(lobeEnergy(0.003, 0.003, 0.25) < 1e-3);
    assert.ok(lobeEnergy(0.1, 0.1, 0) === 1, "a zero-size source is the old delta light");
  });
});

describe("watch materials: tintedF0", () => {
  test("a dielectric's specular is neutral whatever colour the body is", () => {
    assert.deepEqual(tintedF0([0.9, 0.1, 0.05], 0.04, 0), [0.04, 0.04, 0.04]);
  });

  test("a conductor keeps the catalogue's hue exactly and lands at or under the physical level", () => {
    // A neutral swatch can hit its target dead on.
    const steel = tintedF0([0.4, 0.4, 0.4], 0.57, 1);
    assert.ok(Math.abs(lum(steel) - 0.57) < 1e-9, `luminance ${lum(steel)}`);
    // A saturated one cannot without pushing a channel past 1, so it stops
    // there — the HUE is what must not move.
    const gold = tintedF0([0.56, 0.35, 0.09], 0.78, 1);
    assert.ok(gold[0] > gold[1] && gold[1] > gold[2], "gold stays gold-coloured");
    assert.ok(Math.abs(gold[1] / gold[0] - 0.35 / 0.56) < 1e-9, "the hue ratio is exact");
    assert.ok(Math.max(...gold) <= 1, "no channel reflects more than all the light");
    assert.ok(lum(gold) <= 0.78 && lum(gold) > 0.5, `luminance ${lum(gold)}`);
  });

  test("a black swatch cannot divide by zero into a NaN", () => {
    for (const c of tintedF0([0, 0, 0], 0.57, 1)) assert.ok(Number.isFinite(c));
  });
});

describe("watch materials: resolvers over the shipped catalogue", () => {
  test("every case finish resolves to a real conductor", () => {
    for (const f of FINISHES) {
      const id = finishMaterialId(f);
      assert.ok(MATERIALS[id], `${f.id} -> ${id}`);
      assert.equal(MATERIALS[id].metal, 1, `${f.id} must render as metal`);
    }
  });

  test("every strap resolves, and only bracelets resolve to metal", () => {
    for (const s of STRAPS) {
      const id = strapMaterialId(s);
      assert.ok(MATERIALS[id], `${s.id} -> ${id}`);
      const isMetal = MATERIALS[id].metal >= 0.5;
      assert.equal(isMetal, s.kind === "bracelet", `${s.id} (${s.kind}) -> ${id}`);
    }
    assert.equal(strapMaterialId({ kind: "leather" }), "leather");
    assert.equal(strapMaterialId({ kind: "leather", leather: "suede" }), "leather-suede");
    assert.equal(strapMaterialId({ kind: "leather", leather: "Horween shell cordovan" }), "leather-shell");
    assert.equal(strapMaterialId({ kind: "nato", weave: "seatbelt" }), "nylon-seatbelt");
    assert.equal(strapMaterialId({ kind: "rubber" }), "rubber");
    // An explicit material from the catalogue always wins.
    assert.equal(strapMaterialId({ kind: "rubber", material: "leather-croc" }), "leather-croc");
    // And an unknown kind lands on leather rather than on steel.
    assert.equal(MATERIALS[strapMaterialId({ kind: "hemp" })].metal, 0);
  });

  test("every bezel insert resolves, and gloss is what picks ceramic", () => {
    for (const i of INSERTS) {
      const id = insertMaterialId(i);
      assert.ok(MATERIALS[id], `${i.id} -> ${id}`);
    }
    assert.equal(insertMaterialId({ gloss: true, scale: "dive60" }), "ceramic");
    assert.equal(insertMaterialId({ scale: "dive60" }), "aluminium-anodised");
    assert.equal(insertMaterialId({ scale: "none" }), "steel-radial");
    assert.equal(insertMaterialId({ material: "ceramic" }), "ceramic");
    assert.equal(insertMaterialId({ substrate: "anodised aluminium" }), "aluminium-anodised");
  });

  test("every dial finish resolves, and an unknown one lands on matte rather than on metal", () => {
    for (const d of DIALS) {
      const id = dialMaterialId(d);
      assert.ok(MATERIALS[id], `${d.id} -> ${id}`);
    }
    assert.equal(dialMaterialId({ finish: "sunburst" }), "dial-sunburst");
    assert.equal(dialMaterialId({ finish: "clous de paris" }), "dial-guilloche");
    assert.equal(dialMaterialId({ finish: "wombat" }), "dial-matte");
  });

  test("AR coating is the difference between seeing through a crystal and seeing the sky", () => {
    const bare = crystalMaterial({ material: "sapphire", ar: "none", tint: "#dfe9f5" });
    const coated = crystalMaterial({ material: "sapphire", ar: "clear", tint: "#dfe9f5" });
    assert.ok(bare.glass && coated.glass);
    assert.ok(bare.f0[1] > coated.f0[1] * 3, "a coating has to matter");
    assert.ok(Math.abs(bare.f0[1] - 0.077) < 0.002, "sapphire n=1.77 gives F0 0.077");
    for (const c of CRYSTALS) assert.ok(crystalMaterial(c).glass, `${c.id} must take the glass path`);
  });

  test("a mesh the geometry core adds gets a plausible material, and a declared hint wins", () => {
    assert.equal(meshMaterialId("wrist"), "wrist-leather");
    assert.equal(meshMaterialId("wristCylinder"), "wrist-leather");
    assert.equal(meshMaterialId("displayRoll"), "wrist-leather");
    assert.equal(meshMaterialId("buckle"), "steel-brushed");
    assert.equal(meshMaterialId("keeper"), "steel-brushed");
    assert.equal(meshMaterialId("wrist", { wrist: "leather-suede" }), "leather-suede");
    // A hint naming a material that does not exist must not blank the mesh.
    assert.equal(meshMaterialId("wrist", { wrist: "unobtanium" }), "wrist-leather");
    assert.equal(meshMaterialId("somethingNew"), FALLBACK_MATERIAL);
  });

  test("materialFor always returns a complete, finite record", () => {
    for (const id of Object.keys(MATERIALS).concat(["nonsense"])) {
      const m = materialFor(id);
      assert.ok(MATERIALS[m.id], `${id} -> ${m.id}`);
      const numeric = ["rough", "metal", "aniso", "anisoMode", "axis", "grain", "grainFreq", "env", "sheen", "coat", "coatRough"];
      for (const k of numeric) assert.ok(Number.isFinite(m[k]), `${id}.${k}`);
      for (const c of m.color.concat(m.f0, m.sheenColor)) assert.ok(Number.isFinite(c), `${id} colour`);
    }
    // The catalogue's colour drives the render, not a hard-coded swatch.
    const warm = materialFor("gold", "#c8a253");
    const cool = materialFor("gold", "#a0b6d8");
    assert.notDeepEqual(warm.f0, cool.f0);
  });

  test("every fallback swatch is a hex colour for a material that exists", () => {
    for (const [id, hex] of Object.entries(DEFAULT_COLORS)) {
      assert.ok(MATERIALS[id], `${id} has a swatch but no material`);
      assert.match(hex, /^#[0-9a-f]{6}$/i, `${id} swatch`);
    }
  });
});

describe("watch materials: what a dial physically has relief for", () => {
  test("applied indices are raised; ink is not", () => {
    for (const k of ["bar", "dot", "triangle", "facet"]) {
      assert.equal(markerIsApplied(k), true, `${k} is applied metal on these dials`);
    }
    for (const k of ["numeral", "roman", "", "printed"]) {
      assert.equal(markerIsApplied(k), false, `${k} is printed`);
    }
  });

  test("stamped finishes get relief and printed ones do not", () => {
    assert.equal(dialRelief({ finish: "matte" }).pattern, "none");
    assert.equal(dialRelief({ finish: "gloss" }).pattern, "none");
    assert.equal(dialRelief({ finish: "fume" }).pattern, "none");
    const snow = dialRelief({ finish: "textured" });
    assert.equal(snow.pattern, "snowflake");
    assert.ok(snow.patternDepth > 0);
    assert.equal(dialRelief({ texture: "clous de paris" }).pattern, "clous");
    assert.equal(dialRelief({ texture: "waffle" }).pattern, "waffle");
    assert.equal(dialRelief({ texture: "barleycorn guilloche" }).pattern, "guilloche");
    assert.equal(dialRelief({ texture: "linen" }).pattern, "linen");
  });

  test("a date aperture is a cut, and a sandwich dial has to be declared", () => {
    assert.equal(dialRelief({ finish: "matte", date: "3" }).date, "cut");
    assert.equal(dialRelief({ finish: "matte" }).date, "none");
    assert.equal(dialRelief({ finish: "matte" }).sandwich, false);
    assert.equal(dialRelief({ finish: "matte", sandwich: true }).sandwich, true);
    assert.equal(dialRelief({ construction: "sandwich" }).sandwich, true);
  });

  test("every shipped dial produces a usable plan", () => {
    for (const d of DIALS) {
      const plan = dialRelief(d);
      assert.ok(typeof plan.pattern === "string" && plan.pattern.length > 0, d.id);
      assert.ok(plan.patternDepth >= 0 && plan.patternDepth <= 1, d.id);
      assert.equal(plan.ticks, "printed", `${d.id}: a minute track is ink`);
      assert.equal(plan.text, "printed", `${d.id}: dial text is ink`);
    }
  });
});

// ===========================================================================
// The 2026-07-30 catalogue pass (feedback #56 and #57). Appended as its own
// block so parallel work on the geometry half merges cleanly.
//
// What it covers is the half of the builder that is DATA: the dial decomposed
// into orthogonal axes, the date and day wheels as separate parts, the
// per-family caseback truth, the optionality of the parts a case often ships
// with, the strap axes, and the two functions the page is built against —
// compatibleOptions() and surpriseBuild(). The rules it asserts are the ones
// the research established; the numbers are the ones with a source.

import {
  AXIS_SLOTS,
  ALL_SLOTS,
  TEXT_FIELDS,
  DIAL_DESIGNS,
  DIAL_COLOURS,
  DIAL_FINISHES,
  DIAL_CONSTRUCTIONS,
  DIAL_INDEX_STYLES,
  DIAL_CALENDARS,
  DIAL_DIAMETERS,
  DIAL_FEET,
  DIAL_PRINTS,
  DIAL_LUME_OPTIONS,
  DIAL_SPEC,
  DAY_DATE_APERTURE,
  DATE_WHEELS,
  DAY_WHEELS,
  DAY_WHEEL_LANGUAGES,
  INSERT_MATERIALS,
  INSERT_PROFILES,
  CRYSTAL_EDGES,
  CRYSTAL_ARS,
  CHAPTER_RINGS,
  CHAPTER_PRINTINGS,
  CROWNS,
  CROWN_TEXTURES,
  CASEBACKS,
  CASEBACK_ENGRAVINGS,
  CASEBACK_FINISHES,
  BRACELET_TYPES,
  RUBBER_TYPES,
  LEATHER_TYPES,
  NATO_PATTERNS,
  NATO_WEAVES,
  NATO_LAYERS,
  STRAP_COLOURS,
  STITCH_COLOURS,
  HARDWARE_FINISHES,
  BUCKLES,
  SHEEN_LEVELS,
  WRIST_HOLDER,
  STRAP_EXIT,
  LUMES,
  CASE_KITS,
  slotOptions,
  noneOption,
  part,
  caseKit,
  displayBackFor,
  defaultsForCase,
  normalizeBuild,
  resolveBuild,
  checkBuild,
  compatibleOptions,
  surpriseBuild,
  buildSpec,
  sourcingFor,
  decodeBuild,
} from "./watch.js";

/** Every table in the catalogue, for the sweeps that must cover all of them. */
const TABLES = {
  DIALS, DIAL_DESIGNS, DIAL_COLOURS, DIAL_FINISHES, DIAL_CONSTRUCTIONS,
  DIAL_INDEX_STYLES, DIAL_CALENDARS, DIAL_DIAMETERS, DIAL_FEET, DIAL_PRINTS,
  DIAL_LUME_OPTIONS, DATE_WHEELS, DAY_WHEELS, DAY_WHEEL_LANGUAGES,
  INSERTS, INSERT_MATERIALS, INSERT_PROFILES,
  CRYSTALS, CRYSTAL_EDGES, CRYSTAL_ARS,
  CHAPTER_RINGS, CHAPTER_PRINTINGS,
  CROWNS, CROWN_TEXTURES,
  CASEBACKS, CASEBACK_ENGRAVINGS, CASEBACK_FINISHES,
  STRAPS, BRACELET_TYPES, RUBBER_TYPES, LEATHER_TYPES,
  NATO_PATTERNS, NATO_WEAVES, NATO_LAYERS,
  STRAP_COLOURS, STITCH_COLOURS, HARDWARE_FINISHES, BUCKLES, SHEEN_LEVELS,
};

/** A build with every axis at its default. */
const BASE = normalizeBuild(DEFAULT_BUILD);

// ---------------------------------------------------------------------------

describe("the catalogue's own honesty rules", () => {
  test("invariant 6: every catalogue entry carries both languages", () => {
    // Swedish at the same breadth as English, mechanically. A half-translated
    // entry is the easiest thing in the world to let through by hand.
    const visit = (obj, path) => {
      if (!obj || typeof obj !== "object") return;
      if (Array.isArray(obj)) return obj.forEach((v, i) => visit(v, `${path}[${i}]`));
      const keys = Object.keys(obj);
      if (keys.includes("en") || keys.includes("sv")) {
        assert.ok(typeof obj.en === "string" && obj.en.trim(), `${path} has no EN`);
        assert.ok(typeof obj.sv === "string" && obj.sv.trim(), `${path} has no SV`);
        return;
      }
      for (const k of keys) visit(obj[k], `${path}.${k}`);
    };
    for (const [name, table] of Object.entries(TABLES)) {
      assert.ok(table.length > 0, `${name} is empty`);
      for (const row of table) {
        assert.ok(row.id, `${name} row without an id`);
        assert.ok(row.name && row.name.en && row.name.sv, `${name}/${row.id} name`);
        visit(row, `${name}/${row.id}`);
      }
    }
    for (const axis of AXIS_SLOTS) {
      visit(axis.name, `axis/${axis.key}`);
      if (axis.asListed) visit(axis.asListed, `axis/${axis.key}.asListed`);
    }
    for (const field of TEXT_FIELDS) visit(field.name, `text/${field.key}`);
    visit(DAY_DATE_APERTURE.note, "aperture.note");
    visit(WRIST_HOLDER.note, "holder.note");
    visit(STRAP_EXIT.note, "strapExit.note");
    for (const [id, kit] of Object.entries(CASE_KITS)) assert.ok(Array.isArray(kit.includes), id);
  });

  test("invariant 6: every compatibility reason is bilingual and actually translated", () => {
    const seen = new Set();
    let count = 0;
    for (const slot of ALL_SLOTS) {
      for (const row of compatibleOptions(slot.key, BASE)) {
        if (!row.why) continue;
        count++;
        assert.ok(row.why.en && row.why.en.trim(), `${slot.key}/${row.option.id} EN reason`);
        assert.ok(row.why.sv && row.why.sv.trim(), `${slot.key}/${row.option.id} SV reason`);
        assert.notEqual(row.why.en, row.why.sv, `${slot.key}/${row.option.id} reason is untranslated`);
        seen.add(row.why.en);
      }
    }
    assert.ok(count > 20, `only ${count} annotated options — the sweep is not reaching the rules`);
    assert.ok(seen.size >= 5, "the sweep should surface several distinct reasons");
  });

  test("no dimension is invented: every millimetre names a source", () => {
    // The rule the whole file rests on. Anything whose key reads as a
    // measurement has to say where it came from.
    const isMeasurement = (k) => /Mm$|^thickness|^pitch|^taper|^wire|^flutes$|^depth$/.test(k);
    for (const [name, table] of Object.entries(TABLES)) {
      for (const row of table) {
        const measured = Object.keys(row).filter((k) => isMeasurement(k) && row[k] != null);
        if (!measured.length) continue;
        assert.ok(row.src, `${name}/${row.id} quotes ${measured.join(", ")} with no src`);
        assert.ok(SOURCES[row.src], `${name}/${row.id} names unknown source ${row.src}`);
      }
    }
    assert.ok(SOURCES[DIAL_SPEC.src] && DIAL_SPEC.approx === false);
    assert.ok(SOURCES[WRIST_HOLDER.src]);
  });

  test("every source id a table row names actually exists", () => {
    for (const [name, table] of Object.entries(TABLES)) {
      for (const row of table) {
        if (row.src) assert.ok(SOURCES[row.src], `${name}/${row.id} → ${row.src}`);
        for (const also of row.srcAlso || []) assert.ok(SOURCES[also], `${name}/${row.id} → ${also}`);
      }
    }
  });

  test("the machine-generated marketplace \"wiki\" articles are not cited anywhere", () => {
    // They carry outright false claims — one calls the NH36 a Seagull running
    // at 28,800 vph when it is a Seiko Instruments movement at 21,600 — so a
    // src pointing at one quietly poisons the no-invented-millimetres rule
    // that every other number in this file depends on.
    for (const [id, source] of Object.entries(SOURCES)) {
      assert.ok(!/wiki-ssr/.test(source.url), `${id} cites a generated wiki article`);
      for (const host of ["skyrimwrist", "usamodwatch", "rotatewatches"]) {
        assert.ok(!source.url.includes(host), `${id} cites ${host}, flagged as generated content`);
      }
    }
    // And the one claim that used to rest on such a page now RANKS rather than
    // measures, because no manufacturer publishes a figure for Hardlex.
    const hardlex = part("crystal", "domed-hardlex");
    assert.equal(hardlex.approx, true);
    assert.match(hardlex.note.en, /Seiko publishes no hardness number/);
    assert.match(hardlex.note.sv, /publicerar inget hårdhetsvärde/);
    assert.ok(!/HV/.test(hardlex.note.en.replace("HV figures", "")));
  });
});

// ---------------------------------------------------------------------------

describe("feedback #56: the dial is a product of axes, not one fixed atom", () => {
  test("every dial declares the nine axes it is a combination of", () => {
    const has = (table, id) => table.some((r) => r.id === id);
    for (const d of DIALS) {
      assert.ok(has(DIAL_DESIGNS, d.design), `${d.id} design ${d.design}`);
      assert.ok(has(DIAL_COLOURS, d.colour), `${d.id} colour ${d.colour}`);
      assert.ok(has(DIAL_FINISHES, d.finishId), `${d.id} finish ${d.finishId}`);
      assert.ok(has(DIAL_CONSTRUCTIONS, d.construction), `${d.id} construction`);
      assert.ok(has(DIAL_INDEX_STYLES, d.indices), `${d.id} indices`);
      assert.ok(has(DIAL_CALENDARS, d.calendar), `${d.id} calendar ${d.calendar}`);
      assert.ok(has(DIAL_DIAMETERS, d.diameter), `${d.id} diameter`);
      assert.ok(has(DIAL_FEET, d.feet), `${d.id} feet`);
      assert.ok(LUMES[d.lume], `${d.id} lume`);
    }
  });

  test("the axes are ORTHOGONAL: a finish crosses designs, a colour crosses finishes", () => {
    // The structural finding the decomposition exists for. "Sunburst" is sold
    // on sub dials, sandwich dials and dress dials alike, so a catalogue that
    // makes "sunburst black sub dial" one atomic option cannot say what the
    // market actually sells.
    const designsWithSunburst = new Set(DIALS.filter((d) => d.finishId === "sunburst").map((d) => d.design));
    assert.ok(designsWithSunburst.size >= 3, "sunburst must appear across several designs");
    const finishesOnBlack = new Set(DIALS.filter((d) => d.colour === "black").map((d) => d.finishId));
    assert.ok(finishesOnBlack.size >= 3, "black must appear in several finishes");
    // Sandwich is CONSTRUCTION, not finish: a vendor sells "sunburst sandwich",
    // so the two have to be able to co-exist on one dial.
    const sandwich = DIALS.find((d) => d.construction === "sandwich");
    assert.ok(sandwich);
    assert.equal(sandwich.finishId, "sunburst");
  });

  test("an axis override changes the dial the renderer is handed", () => {
    const plain = resolveBuild(BASE).parts.dial;
    assert.equal(plain.base, "#0d0f12");
    const recoloured = resolveBuild({ ...BASE, dialColor: "green" }).parts.dial;
    assert.equal(recoloured.base, DIAL_COLOURS.find((c) => c.id === "green").hex);
    // ...and the legacy shading bucket the renderer switches on still resolves.
    const refinished = resolveBuild({ ...BASE, dialFinish: "fume" }).parts.dial;
    assert.equal(refinished.finish, "fume");
    assert.equal(refinished.finishId, "fume");
    const guilloche = resolveBuild({ ...BASE, dialFinish: "guilloche" }).parts.dial;
    assert.equal(guilloche.finish, "textured", "a new finish must still map to a bucket the renderer paints");
  });

  test("the calendar axis rewrites the dial's date and day windows", () => {
    const none = resolveBuild({ ...BASE, dialCalendar: "none" }).parts.dial;
    assert.equal(none.date, null);
    assert.equal(none.day, false);
    const dayDate = resolveBuild({ ...BASE, dialCalendar: "day-date-3" }).parts.dial;
    assert.equal(dayDate.day, true);
    assert.equal(dayDate.date, "3");
    // ...and the compatibility engine sees the rewritten dial, not the listing.
    assert.equal(checkBuild({ ...BASE, movement: "nh36", dialCalendar: "day-date-3" }).ok, true);
    assert.equal(checkBuild({ ...BASE, movement: "nh35", dialCalendar: "day-date-3" }).ok, false);
  });

  test("the surfaces that are physically 3D are marked, and the flat ones are not", () => {
    const relief = (id) => resolveBuild({ ...BASE, dial: id }).parts.dial.relief;
    assert.equal(relief("sandwich-black"), "recessed");
    assert.equal(relief("openheart"), "pierced");
    assert.equal(relief("sunburst-blue"), "flat");
    assert.equal(relief("fume-grey"), "flat");
    assert.equal(DIAL_FINISHES.find((f) => f.id === "sunburst").relief, "flat");
    assert.equal(DIAL_FINISHES.find((f) => f.id === "meteorite").relief, "flat");
    // Anything claimed as relief on inference rather than a source says so.
    for (const f of DIAL_FINISHES) {
      if (f.relief && f.relief !== "flat") assert.ok(f.reliefApprox || f.src, `${f.id} relief unsourced`);
    }
  });

  test("oversize dials are listed but only fit cases built around them", () => {
    const big = DIAL_DIAMETERS.find((d) => d.id === "31-8");
    assert.ok(big.mm > 28.5 && big.approx === true);
    const r = checkBuild({ ...BASE, dialDiameter: "31-8" });
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.level === "error" && i.slots.includes("dial")));
    for (const plat of Object.values(PLATFORMS)) assert.equal(plat.dialDia, 28.5);
  });

  test("dial feet are a real fitment axis, with the drawing's own dimensions", () => {
    const four = DIAL_FEET.find((f) => f.id === "feet4");
    assert.equal(four.feet, 4);
    assert.equal(four.footDiaMm, DIAL_SPEC.footDiaMm);
    assert.equal(four.footLengthMm, DIAL_SPEC.footLengthMm);
    const glue = checkBuild({ ...BASE, dialFeet: "glue" });
    assert.ok(glue.issues.some((i) => i.level === "note" && i.slots.includes("dialFeet")));
  });
});

// ---------------------------------------------------------------------------

describe("feedback #56: custom dial text, and sterile as a real choice", () => {
  test("all four text slots are optional and sterile is the default", () => {
    assert.deepEqual(TEXT_FIELDS.filter((f) => f.group === "dialText").map((f) => f.key),
      ["textLogo", "text12", "text6a", "text6b"]);
    assert.equal(BASE.dialPrint, undefined, "the default build carries no print method at all");
    const dial = resolveBuild(BASE).parts.dial;
    assert.equal(dial.printMethod, "sterile");
    assert.deepEqual(dial.text, []);
    assert.equal(dial.customText, null);
    // And sterile is a product in the catalogue, not merely the absence of one.
    assert.ok(DIALS.some((d) => d.design === "sterile-plain"));
  });

  test("setting the text slots puts them on the dial with the chosen method", () => {
    const build = normalizeBuild({
      ...BASE,
      dialPrint: "pad-print",
      textLogo: "NORDVIK",
      text12: "Automatic",
      text6a: "200m",
    });
    const dial = resolveBuild(build).parts.dial;
    assert.equal(dial.printMethod, "pad-print");
    assert.deepEqual(dial.text, ["NORDVIK", "Automatic", "200m"]);
    assert.equal(dial.customText.logo, "NORDVIK");
    assert.equal(dial.customText.method, "pad-print");
    // The vendor-stated limit is surfaced rather than assumed away.
    const issue = checkBuild(build).issues.find((i) => i.slots.includes("dialPrint"));
    assert.ok(issue);
    assert.match(issue.en, /trademark/i);
    assert.match(issue.sv, /varumärke/i);
  });

  test("laser marking is not the same look as pad printing", () => {
    const laser = DIAL_PRINTS.find((p) => p.id === "laser-mark");
    assert.match(laser.note.en, /metallic grey/);
    assert.equal(DIAL_PRINTS.find((p) => p.id === "applied-logo").relief, "raised");
  });

  test("dial text survives a permalink, and cannot break the codec", () => {
    // The codec is `key:value;key:value`, so a colon or semicolon in free text
    // would corrupt every field after it.
    const build = normalizeBuild({ ...BASE, dialPrint: "pad-print", textLogo: "A:B;C DIVER" });
    assert.ok(!build.textLogo.includes(":"));
    assert.ok(!build.textLogo.includes(";"));
    const round = decodeBuild(encodeBuild(build));
    assert.equal(round.textLogo, build.textLogo);
    assert.equal(round.dialPrint, "pad-print");
  });
});

// ---------------------------------------------------------------------------

describe("feedback #56: the date wheel is a separate part", () => {
  test("the disc and its text are chosen together, from verified combinations", () => {
    // The finding this rests on: the date disc is not a dial property, it is a
    // part you buy and swap 1:1 onto the movement, listed by disc and text.
    assert.ok(AXIS_SLOTS.some((a) => a.key === "dateWheel"));
    const white = DATE_WHEELS.find((w) => w.id === "white-black");
    const black = DATE_WHEELS.find((w) => w.id === "black-white");
    assert.equal(white.disc, "#f2f4f7");
    assert.equal(white.text, "#15181c");
    assert.equal(black.disc, "#111318");
    assert.equal(black.text, "#f2f5fa");
    // Provenance: the two Seiko part numbers.
    assert.equal(white.seikoPart, "0148 141");
    assert.equal(black.seikoPart, "0148 142");
    for (const w of DATE_WHEELS) {
      assert.match(w.disc, /^#[0-9a-f]{6}$/i, w.id);
      assert.match(w.text, /^#[0-9a-f]{6}$/i, w.id);
    }
  });

  test("a date wheel needs a date movement and a day wheel needs the NH36", () => {
    assert.equal(checkBuild({ ...BASE, movement: "nh70", dialCalendar: "none", dateWheel: "black-white" }).ok, false);
    assert.equal(checkBuild({ ...BASE, dateWheel: "black-white" }).ok, true);
    const dayOnNh35 = checkBuild({ ...BASE, dayWheel: "kanji-black-3" });
    assert.equal(dayOnNh35.ok, false);
    assert.ok(dayOnNh35.issues.some((i) => i.slots.includes("dayWheel") && i.level === "error"));
  });

  test("the day wheel carries language, and only the ones sold as NHxx parts", () => {
    const langs = new Set(DAY_WHEELS.map((w) => w.language));
    assert.deepEqual([...langs].sort(), ["arabic", "en-es", "hanzi", "kanji"]);
    assert.deepEqual(DAY_WHEEL_LANGUAGES.map((l) => l.id).sort(), ["arabic", "en-es", "hanzi", "kanji"]);
    // French, German, Danish and Roman numerals are documented for finished
    // Seiko 5s but were NOT found as purchasable mod discs, so they are absent.
    for (const missing of ["french", "german", "danish", "roman"]) {
      assert.ok(!langs.has(missing), `${missing} is not verified as a purchasable NHxx disc`);
    }
  });

  test("the day wheel is pre-aligned to a crown position and the date wheel is not", () => {
    // The one asymmetry between the two discs, and it constrains the CASE.
    const dayDate = { ...BASE, movement: "nh36", dial: "daydate-black" };
    // The SKX007 has its crown at 4, so a 3 o'clock day wheel reads rotated.
    const mismatched = checkBuild({ ...dayDate, dayWheel: "kanji-black-3" });
    assert.ok(mismatched.issues.some((i) => i.slots.includes("dayWheel") && i.level === "warning"));
    const matched = checkBuild({ ...dayDate, dayWheel: "kanji-black-4" });
    assert.ok(!matched.issues.some((i) => i.slots.includes("dayWheel") && i.level === "warning"));
    // The date wheel has no such constraint — it swaps 1:1.
    for (const w of DATE_WHEELS) assert.equal(w.crownAlign, undefined, w.id);
  });
});

// ---------------------------------------------------------------------------

describe("feedback #56: the day-date aperture", () => {
  test("the arrangement is stated ONCE, as sourced fact", () => {
    assert.equal(DAY_DATE_APERTURE.inboard, "day");
    assert.equal(DAY_DATE_APERTURE.resolved, true);
    assert.equal(DAY_DATE_APERTURE.layout, "pillar-box");
    assert.ok(SOURCES[DAY_DATE_APERTURE.src].url.endsWith(".pdf"), "the source is the manufacturer's drawing");
  });

  test("the cut-outs are the manufacturer's own dimensions", () => {
    const dd = DAY_DATE_APERTURE.dayDate;
    const d = DAY_DATE_APERTURE.dateOnly;
    assert.deepEqual([dd.widthMm, dd.heightMm, dd.centreFromDialCentreMm], [7.0, 2.0, 8.45]);
    assert.deepEqual([d.widthMm, d.heightMm, d.centreFromDialCentreMm], [2.9, 2.0, 10.55]);
    assert.equal(dd.approx, false);
    assert.equal(d.approx, false);
    // The geometric proof of day-inboard, asserted rather than described: the
    // two windows share an OUTER edge, so all the extra width goes inboard.
    assert.ok(Math.abs(dd.outerMm - d.outerMm) <= 0.06, "the two windows share an outer edge");
    assert.ok(dd.innerMm < d.innerMm, "the day-date box extends inboard, not outboard");
    // Sanity against the dial itself: the window has to sit inside it.
    assert.ok(dd.outerMm < DIAL_SPEC.diaMm / 2);
    assert.equal(DIAL_SPEC.diaMm, 28.5);
  });

  test("the two cells never overlap and the day cell is the wider one", () => {
    const { dayWidthShare, gapShare, dateWidthShare } = DAY_DATE_APERTURE;
    assert.ok(Math.abs(dayWidthShare + gapShare + dateWidthShare - 1) < 0.02, "the shares must fill the window");
    assert.ok(gapShare > 0, "there must be a visible gap — clipping is the reported bug");
    assert.ok(dayWidthShare > dateWidthShare, "three letters need more room than two digits");
    // Those three are the only figures here that came off a photograph.
    assert.equal(DAY_DATE_APERTURE.sharesApprox, true);
  });

  test("the spec sheet reports the aperture the chosen calendar implies", () => {
    assert.equal(buildSpec({ ...BASE, movement: "nh36", dial: "daydate-black" }).aperture.widthMm, 7.0);
    assert.equal(buildSpec(BASE).aperture.widthMm, 2.9);
    assert.equal(buildSpec({ ...BASE, movement: "nh70", dial: "62mas-cream" }).aperture, null);
  });
});

// ---------------------------------------------------------------------------

describe("feedback #56: casebacks", () => {
  test("the exhibition back is the default exactly where one was found listed", () => {
    for (const id of ["skx007", "srp-turtle", "samurai", "tuna", "skx013"]) {
      assert.equal(displayBackFor(id), true, id);
      assert.equal(defaultsForCase(id).caseback, "display", id);
    }
    // ...and NOT where the research found none. Defaulting these to exhibition
    // would be inventing a part nobody sells.
    for (const id of ["willard", "alpinist", "explorer", "field"]) {
      assert.equal(displayBackFor(id), null, id);
      assert.equal(defaultsForCase(id).caseback, "solid-brushed", id);
    }
    const warned = checkBuild({ ...BASE, case: "willard", caseback: "display" });
    assert.ok(warned.issues.some((i) => i.slots.includes("caseback") && i.level === "warning"));
  });

  test("an engraved back is a DECAL on the solid shape, not its own geometry", () => {
    // The likely root cause of "engraved caseback isn't working": it is
    // dimensionally identical to a plain solid back and differs only in relief
    // artwork, so if it has a mesh of its own that is the bug.
    const engraved = resolveBuild({ ...BASE, caseback: "solid-engraved" }).parts.caseback;
    const plain = resolveBuild({ ...BASE, caseback: "solid-brushed" }).parts.caseback;
    assert.equal(engraved.geometry, "solid");
    assert.equal(plain.geometry, "solid");
    assert.equal(engraved.heightDeltaMm, plain.heightDeltaMm);
    assert.equal(engraved.display, false);
    assert.equal(resolveBuild({ ...BASE, caseback: "display" }).parts.caseback.geometry, "display");
    // The artwork is an axis over the solid part, with real listed designs.
    const ids = CASEBACK_ENGRAVINGS.map((e) => e.id);
    for (const design of ["sword", "explorer", "serpent", "skull", "robocop"]) assert.ok(ids.includes(design));
    const custom = resolveBuild({ ...BASE, casebackEngraving: "custom-text", casebackText: "For Elin" }).parts.caseback;
    assert.equal(custom.engravingText, "For Elin");
    assert.equal(custom.geometry, "solid");
  });

  test("a display back adds the one published height delta and nothing else does", () => {
    assert.equal(part("caseback", "display").heightDeltaMm, 0.6);
    assert.equal(part("caseback", "solid-brushed").heightDeltaMm, 0);
    const solid = buildSpec({ ...BASE, caseback: "solid-brushed" });
    const display = buildSpec({ ...BASE, caseback: "display" });
    assert.ok(Math.abs(display.backMm - solid.backMm - 0.6) < 1e-9);
    assert.ok(display.stackMm > solid.stackMm);
  });

  test("the display back's spacer fork is a real error on an NH build", () => {
    // Two SKUs that are not interchangeable: one for the thicker black OEM
    // spacer, one for the thinner grey NH spacer. Every movement here is an NH.
    const wrong = checkBuild({ ...BASE, caseback: "display-oem" });
    assert.equal(wrong.ok, false);
    assert.ok(wrong.issues.some((i) => i.slots.includes("caseback") && i.slots.includes("movement")));
    assert.equal(checkBuild({ ...BASE, caseback: "display" }).ok, true);
    assert.equal(part("caseback", "display").spacerFit, "grey-nh");
  });
});

// ---------------------------------------------------------------------------

describe("feedback #59: the exhibition back is a HOLE, and there is something behind it", () => {
  // Reported in #56, answered, and reported again in #59 unchanged: "clear /
  // exhibition caseback still doesn't work". It never worked. The resolver set
  // parts.caseback.geometry = "display" and NOTHING read it — the mesh builder
  // always lathed a solid puck, the renderer always picked steel.
  //
  // The suite was green through both rounds because the only assertion about a
  // display back was on `parts.caseback.geometry`: the resolver's own output,
  // one layer above BOTH places the defect lived. So every test here is on the
  // mesh or on the material id, and that is the point of them.

  /** Signed volume: positive means the winding puts the normals outside. */
  const volume = (m) => {
    let v = 0;
    for (let t = 0; t < m.indices.length; t += 3) {
      const p = [0, 1, 2].map((k) => {
        const i = m.indices[t + k] * 3;
        return [m.positions[i], m.positions[i + 1], m.positions[i + 2]];
      });
      const [a, b, c] = p;
      v +=
        (a[0] * (b[1] * c[2] - b[2] * c[1]) -
          a[1] * (b[0] * c[2] - b[2] * c[0]) +
          a[2] * (b[0] * c[1] - b[1] * c[0])) /
        6;
    }
    return v;
  };
  const radii = (m) => verts(m).map((p) => Math.hypot(p[0], p[2]));
  const ys = (m) => verts(m).map((p) => p[1]);
  const built = (caseback) => buildMeshes({ ...BASE, case: "skx007", caseback }, { segments: 48 });

  test("the metal has a hole in it exactly when the back is a display back", () => {
    const display = built("display");
    const solid = built("solid-brushed");
    assert.ok(display.caseback.display, "the build did not resolve to a display back");
    // THE assertion the old test should have been: a solid back reaches the
    // axis, a display back does not — there is a window where the steel was.
    assert.ok(Math.min(...radii(solid.meshes.caseback)) < 1e-9, "a solid back should be a closed puck");
    const innerR = Math.min(...radii(display.meshes.caseback));
    assert.ok(innerR > 3, `the display back still closes over the axis (inner radius ${innerR})`);
    assert.ok(Math.abs(innerR - display.caseback.windowR) < 1e-6, "the mesh's hole is not the window it reports");
    // And the hole is a WINDOW, not a gap: wide enough to see a movement,
    // narrow enough to leave the ring the back screws down by.
    const outerR = Math.max(...radii(display.meshes.caseback));
    assert.ok(innerR > outerR * 0.35 && innerR < outerR * 0.8, `window ${innerR} against a back of ${outerR}`);
  });

  test("something transparent fills the window, and the material table agrees it is glass", () => {
    const display = built("display");
    const glass = display.meshes.casebackCrystal;
    assert.ok(glass && glass.indices.length > 0, "no window mesh at all");
    // The second half of the original defect was in the RENDERER: the caseback
    // took a steel material unconditionally. So assert on what the material
    // layer resolves, not on the mesh being present.
    const id = meshMaterialId("casebackCrystal", display.materials);
    assert.equal(id, "sapphire");
    assert.equal(MATERIALS[id].glass, true, "the window resolves to a material that is not transparent");
    assert.ok(materialFor(id).glass, "materialFor drops the glass flag the shader switches on");
    // It covers the hole rather than sitting in the middle of it.
    assert.ok(Math.max(...radii(glass)) >= display.caseback.windowR, "the window glass is narrower than the window");
    assert.equal(built("solid-brushed").meshes.casebackCrystal, undefined, "a solid back has no window glass");
  });

  test("what is behind the glass is a movement, not a featureless drum", () => {
    // "The interior it would reveal is a plain cylinder, which through glass
    // would look like a fault rather than a movement." A transparent back over
    // nothing is the same bug in a nicer costume.
    const display = built("display");
    const solid = built("solid-brushed");
    for (const key of ["movement", "movementBridges", "rotor", "movementJewels"]) {
      assert.ok(display.meshes[key], `a display back with no ${key}`);
    }
    assert.equal(solid.meshes.rotor, undefined);
    assert.equal(solid.meshes.movementBridges, undefined);
    assert.equal(solid.meshes.movementJewels, undefined);
    // The parts that make it recognisable are their own materials — a rotor
    // that took the plate's response would be a disc on a disc.
    const mat = (k) => meshMaterialId(k, display.materials);
    assert.equal(mat("movement"), "movement-base");
    assert.equal(mat("movementBridges"), "movement-plate");
    assert.equal(mat("rotor"), "movement-rotor");
    assert.equal(mat("movementJewels"), "jewel-ruby");
    assert.notEqual(mat("rotor"), mat("movementBridges"));
    assert.equal(MATERIALS[mat("movementJewels")].metal, 0, "a jewel is a dielectric");
    // The mainplate has to be DARKER than what is bolted to it, or the shapes
    // are 0.3 mm of relief on a disc and read as one flat grey — which is what
    // the first render of this actually looked like.
    assert.ok(
      MATERIALS[mat("movement")].reflect < MATERIALS[mat("movementBridges")].reflect,
      "the bridges cannot separate from a mainplate that reflects as much as they do",
    );
    assert.ok(volume(display.meshes.movementBridges) > 10, "the bridges have no relief to catch light on");
  });

  test("nothing behind the glass pokes through it, or floats off the plate", () => {
    for (const id of ["skx007", "srp-turtle", "samurai", "tuna", "skx013"]) {
      const r = buildMeshes({ ...BASE, case: id, caseback: "display" }, { segments: 32 });
      const glassTop = Math.max(...ys(r.meshes.casebackCrystal));
      const floor = r.geo.floorY;
      for (const key of ["rotor", "movementJewels", "movementBridges"]) {
        const lo = Math.min(...ys(r.meshes[key]));
        const hi = Math.max(...ys(r.meshes[key]));
        assert.ok(lo > glassTop, `${id}: the ${key} is inside the sapphire (${lo} vs ${glassTop})`);
        assert.ok(hi <= floor + 1e-9, `${id}: the ${key} stands proud of the movement plate`);
      }
      // The rotor is the part nearest the glass: it sweeps OVER the bridges.
      assert.ok(
        Math.max(...ys(r.meshes.rotor)) < Math.max(...ys(r.meshes.movement)),
        `${id}: the rotor is not in front of the movement`,
      );
    }
  });

  test("every new solid is wound outward, which the eye cannot check", () => {
    // A flat disc wound inside-out renders almost identically — culling shows
    // its underside a fraction of a millimetre away and the shader relights it.
    // So this is a numeric check or it is no check.
    const r = built("display");
    for (const key of ["caseback", "movement", "movementBridges", "rotor", "movementJewels", "casebackCrystal"]) {
      assert.ok(volume(r.meshes[key]) > 0, `${key} is inside out (signed volume ${volume(r.meshes[key])})`);
    }
    const d = movementDetail(13.7, 2.1, 48);
    for (const [k, m] of Object.entries({ bridges: d.bridges, rotor: d.rotor, jewels: d.jewels })) {
      assert.ok(volume(m) > 0, `${k} is inside out`);
    }
  });

  test("the engraving is a decal that exists only when something is engraved", () => {
    // The OTHER half of the same report — "neither is engraved caseback
    // seemingly". #56 answered it by making an engraved back share the solid
    // back's shape, which is correct and put nothing on that shape.
    const plain = built("solid-brushed");
    const engraved = built("solid-engraved");
    assert.equal(plain.meshes.casebackArt, undefined, "a plain back carries engraving geometry");
    assert.ok(engraved.meshes.casebackArt, "an engraved back carries nothing to engrave");
    assert.equal(engraved.caseback.engraving, "sword");
    // It must not become its own SHAPE: the two backs are dimensionally
    // identical, which is what the #56 test pinned and stays true.
    assert.deepEqual(engraved.meshes.caseback.positions, plain.meshes.caseback.positions);
    // Custom text reaches the renderer, which is what paints it.
    const custom = buildMeshes(
      { ...BASE, case: "skx007", caseback: "solid-brushed", casebackEngraving: "custom-text", casebackText: "For Elin" },
      { segments: 32 },
    );
    assert.equal(custom.caseback.engravingText, "For Elin");
    assert.ok(custom.meshes.casebackArt);
    // A display back has no metal in the middle to engrave.
    assert.equal(built("display").meshes.casebackArt, undefined);
  });

  test("a display back does not reopen the case (feedback #56's own fix)", () => {
    // The coupling worth keeping in front of whoever changes this next: #56 was
    // fixed by CLOSING the case, and that is exactly what a display back has to
    // show through. Cutting the window must not cut a hole into the room.
    for (const id of ["skx007", "tuna", "skx013"]) {
      const r = buildMeshes({ ...BASE, case: id, caseback: "display" }, { segments: 24 });
      const tris = [];
      for (const n of ["case", "caseback", "movement", "lugs", "crown"]) tris.push(...triangles(r.meshes[n]));
      let checked = 0;
      for (let ai = 0; ai < 8; ai++) {
        const a = (ai / 8) * Math.PI * 2;
        const o = [Math.cos(a) * 300, r.geo.dialY * 0.5 + 40, Math.sin(a) * 300];
        for (const aim of [
          [0, r.geo.dialY - 0.6, 0],
          [r.dialR * 0.5, r.geo.dialY + 0.2, 0],
        ]) {
          const d = [aim[0] - o[0], aim[1] - o[1], aim[2] - o[2]];
          const L = Math.hypot(d[0], d[1], d[2]);
          const dir = [d[0] / L, d[1] / L, d[2] / L];
          let count = 0;
          for (const t of tris) if (rayHit(o, dir, t) !== null) count++;
          assert.equal(count % 2, 0, `${id}: a display back opened a sightline through the case`);
          checked++;
        }
      }
      assert.equal(checked, 16);
    }
  });
});

// ---------------------------------------------------------------------------

describe("feedback #56: nothing is mandatory that a case may already ship", () => {
  test("the three optional slots accept \"none\", and part() answers null for it", () => {
    const optional = SLOTS.filter((s) => s.optional).map((s) => s.key);
    assert.deepEqual(optional, ["insert", "chapterRing", "crystal"]);
    for (const key of optional) {
      assert.equal(part(key, "none"), null, `${key}: "none" is not an option object`);
      assert.equal(normalizeBuild({ ...BASE, [key]: "none" })[key], "none", `${key} must keep "none"`);
      assert.ok(noneOption(key).name.en && noneOption(key).name.sv, `${key} none needs a bilingual label`);
      // ...and nothing downstream ever meets a null part.
      const { parts, omitted } = resolveBuild({ ...BASE, [key]: "none" });
      assert.equal(omitted[key], true);
      assert.ok(parts[key] && parts[key].id === "none");
    }
    assert.equal(buildSpec({ ...BASE, crystal: "none" }).omitted.crystal, true);
  });

  test("optionality falls out of what the case ships with, not a special case", () => {
    // The better model: every case carries what is in its box, so a part is
    // free when it is included and priced when it is not.
    assert.deepEqual(caseKit("skx007").includes.slice().sort(),
      ["caseback", "chapterRing", "crown", "crystal", "insert"]);
    assert.deepEqual(caseKit("62mas").includes, [], "a bare body ships gaskets and a click spring");
    // Same case, a dearer crystal: free on a complete kit, priced on a bare body.
    const kitCheap = buildSpec({ ...BASE, case: "skx007", crystal: "domed-hardlex" });
    const kitDear = buildSpec({ ...BASE, case: "skx007", crystal: "top-hat-sapphire" });
    assert.equal(kitDear.priceUsd.high, kitCheap.priceUsd.high, "a crystal the case ships with adds nothing");
    const bareCheap = buildSpec({ ...BASE, case: "62mas", crystal: "domed-hardlex" });
    const bareDear = buildSpec({ ...BASE, case: "62mas", crystal: "top-hat-sapphire" });
    assert.ok(bareDear.priceUsd.high > bareCheap.priceUsd.high, "a separately bought crystal is priced");
    const rows = sourcingFor({ ...BASE, case: "skx007" });
    assert.equal(rows.find((r) => r.slot === "crystal").includedWithCase, true);
    assert.equal(sourcingFor({ ...BASE, case: "62mas" }).find((r) => r.slot === "crystal").includedWithCase, false);
  });

  test("the chapter ring is genuinely MANDATORY on the SKX013 platform", () => {
    // Not a free choice: without it the dial sits too low and the hands do not
    // clear. This is the warning case the whole dropdown pattern exists for.
    assert.equal(PLATFORMS.skx013.chapterRingRequired, true);
    const bad = checkBuild({ ...BASE, case: "skx013", chapterRing: "none" });
    assert.equal(bad.ok, false);
    const issue = bad.issues.find((i) => i.slots.includes("chapterRing"));
    assert.equal(issue.level, "error");
    assert.match(issue.en, /hands will not clear/);
    assert.match(issue.sv, /visarna går inte fria/);
    // Elsewhere it is allowed, with the consequence spelled out.
    const soft = checkBuild({ ...BASE, case: "skx007", chapterRing: "none" });
    assert.equal(soft.ok, true);
    assert.equal(soft.issues.find((i) => i.slots.includes("chapterRing")).level, "warning");
  });
});

// ---------------------------------------------------------------------------

describe("feedback #56: crystals and inserts", () => {
  test("a flat crystal is genuinely flat, and the bevel is an option on the rim", () => {
    // The correction the feedback named: every flat sapphire sold for these
    // cases has a planar top face. The only relief is at the rim, and vendors
    // sell both variants as separate SKUs.
    const flat = resolveBuild({ ...BASE, crystal: "flat-sapphire" }).parts.crystal;
    assert.equal(flat.profile, "flat");
    assert.equal(flat.dome, 0, "a flat crystal must not revolve a dome");
    assert.equal(flat.topFacePlanar, true);
    assert.equal(resolveBuild({ ...BASE, crystal: "domed-hardlex" }).parts.crystal.dome, 0);
    const domed = resolveBuild({ ...BASE, crystal: "dd-sapphire" }).parts.crystal;
    assert.ok(domed.dome > 0);
    assert.equal(domed.topFacePlanar, false);
    // The chamfer is a straight cut whose width nobody publishes.
    assert.equal(CRYSTAL_EDGES.find((e) => e.id === "bevel").approx, true);
    assert.equal(CRYSTAL_EDGES.find((e) => e.id === "none").chamferMm, 0);
  });

  test("R1: a crystal cut for one insert profile warns under the other", () => {
    // The #1 real trap: crystal vendors name SKUs after the insert they pair
    // with, because a sloped insert intrudes 0.9 mm further inward.
    const r = checkBuild({ ...BASE, insertProfile: "flat", crystalEdge: "stepped" });
    const issue = r.issues.find((i) => i.slots.includes("crystal") && i.slots.includes("insert"));
    assert.ok(issue, "a stepped crystal over a flat insert must warn");
    assert.match(issue.en, /step or gap/);
    assert.match(issue.sv, /steg eller en glipa/);
    // Matched profiles are silent.
    assert.ok(!checkBuild({ ...BASE, insertProfile: "sloped", crystalEdge: "stepped" }).issues
      .some((i) => i.slots.includes("crystal") && i.slots.includes("insert")));
    // The published mechanism: the difference is entirely the INNER diameter.
    const p = PLATFORMS.skx.insertProfiles;
    assert.equal(p.flat.od, p.sloped.od);
    assert.ok(p.sloped.id < p.flat.id);
    assert.ok(Math.abs((p.flat.id - p.sloped.id) - 0.9) < 1e-9);
  });

  test("insert material carries the thickness, and the disputed one carries its range", () => {
    const alu = INSERT_MATERIALS.find((m) => m.id === "aluminium");
    assert.deepEqual(alu.thicknessRangeMm, [0.7, 1.0]);
    assert.equal(alu.approx, true);
    assert.equal(INSERT_MATERIALS.find((m) => m.id === "ceramic").thicknessMm, 1.0);
    assert.equal(INSERT_MATERIALS.find((m) => m.id === "steel").thicknessMm, 0.9);
    const swapped = resolveBuild({ ...BASE, insertMaterial: "steel" }).parts.insert;
    assert.equal(swapped.material, "steel");
    assert.equal(swapped.thicknessMm, 0.9);
    // A tachymeter insert is NOT offered on these dive platforms — none found.
    for (const i of INSERTS) assert.notEqual(i.scale, "tachymeter");
  });

  test("the SKX013 crystal is 28 mm — not the 28.5 mm that is the DIAL", () => {
    assert.equal(PLATFORMS.skx013.crystalDia, 28);
    assert.equal(PLATFORMS.skx013.dialDia, 28.5);
    assert.match(PLATFORMS.skx013.note.en, /28\.5 mm is the DIAL diameter/);
    assert.equal(PLATFORMS.srp.crystalDia, 32);
  });
});

// ---------------------------------------------------------------------------

describe("feedback #56: straps", () => {
  test("bracelet types differ in the two things that actually distinguish them", () => {
    // Links across the width and their cross-section. Rendered as one flat box
    // an Oyster and a Jubilee are identical, which was the reported bug.
    const by = (id) => BRACELET_TYPES.find((b) => b.id === id);
    assert.equal(by("oyster").linksAcross, 3);
    assert.equal(by("oyster").crossSection, "flat");
    assert.equal(by("jubilee").linksAcross, 5);
    assert.equal(by("jubilee").crossSection, "rounded");
    assert.equal(by("president").linksAcross, 3);
    assert.equal(by("president").crossSection, "semi-circular");
    assert.equal(by("beads-of-rice").linksAcross, 7);
    assert.equal(by("engineer-ii").taperMm, 0, "the Engineer II genuinely does not taper");
    // A shorter pitch means more hinges, which is what makes a jubilee drape.
    assert.ok(by("jubilee").pitchMm < by("oyster").pitchMm);
    assert.equal(by("milanese").linksAcross, 0, "mesh is woven wire, not links");
    assert.ok(by("shark-mesh").wireMm > by("milanese").wireMm);
    // Per-link widths are published nowhere, so every ratio says it is a convention.
    for (const b of BRACELET_TYPES) {
      if (!b.widthRatios) continue;
      assert.equal(b.ratiosApprox, true, `${b.id} ratios must be flagged`);
      assert.ok(Math.abs(b.widthRatios.reduce((a, x) => a + x, 0) - 1) < 0.01, b.id);
      assert.equal(b.widthRatios.length, b.linksAcross, b.id);
    }
  });

  test("leather comes in real types, and NONE of them renders as a mirror", () => {
    // The direct fix for "leather shouldn't be shiny like a mirror".
    const scale = SHEEN_LEVELS.map((s) => s.id);
    assert.deepEqual(scale, ["matte", "satin", "shiny", "glossy"]);
    assert.ok(LEATHER_TYPES.length >= 12);
    for (const t of LEATHER_TYPES) {
      assert.ok(scale.includes(t.sheen), `${t.id} sheen ${t.sheen}`);
      if (t.sheen === "glossy") assert.equal(t.id, "patent", "only patent is high-gloss");
      assert.notEqual(t.sheen, "shiny", `${t.id} should not be shiny`);
    }
    // Suede and nubuck have NO specular at all — the firmly sourced part.
    for (const id of ["suede", "nubuck"]) {
      assert.equal(LEATHER_TYPES.find((t) => t.id === id).specular, 0, id);
    }
    const strap = resolveBuild({ ...BASE, strap: "leather", leatherType: "suede" }).parts.strap;
    assert.equal(strap.sheen, "matte");
    assert.equal(strap.specular, 0);
    assert.equal(strap.grain, "nap");
  });

  test("stitch colour is its own axis, with its own pitch", () => {
    assert.ok(STITCH_COLOURS.some((s) => s.id === "none"));
    assert.ok(STITCH_COLOURS.some((s) => s.id === "tonal"));
    const strap = resolveBuild({ ...BASE, strap: "leather", strapStitch: "red" }).parts.strap;
    assert.equal(strap.stitch, "red");
    assert.equal(strap.stitchColor, "#9d2029");
    assert.ok(strap.stitchPitchMm > 1.5 && strap.stitchPitchMm < 2.2);
  });

  test("both Bond NATOs ship, because the popular one is not the real one", () => {
    const grey = NATO_PATTERNS.find((p) => p.id === "bond-grey");
    const original = NATO_PATTERNS.find((p) => p.id === "bond-1964");
    assert.ok(grey && original);
    assert.match(grey.note.en, /NOT the strap worn in Goldfinger/);
    assert.match(original.note.en, /nine stripes/);
    assert.match(original.note.sv, /nio ränder/);
    const strap = resolveBuild({ ...BASE, strap: "nato", natoPattern: "bond-1964" }).parts.strap;
    assert.equal(strap.pattern, "bond-1964");
    assert.ok(Array.isArray(strap.stripes) && strap.stripes.length > 2);
  });

  test("NATO weave and construction change the mesh, not just the label", () => {
    const standard = resolveBuild({ ...BASE, strap: "nato" }).parts.strap;
    assert.equal(standard.thicknessMm, 1.25);
    assert.equal(standard.sheen, "matte");
    assert.equal(standard.rings, 5);
    assert.equal(standard.underFlap, true);
    const seatbelt = resolveBuild({ ...BASE, strap: "nato", natoWeave: "seatbelt", natoLayers: "single-pass" }).parts.strap;
    assert.equal(seatbelt.thicknessMm, 1.4);
    assert.equal(seatbelt.sheen, "satin", "seatbelt is the slightly shiny one");
    assert.equal(seatbelt.rings, 3);
    assert.equal(seatbelt.underFlap, false);
    assert.equal(standard.lengthMm, 290);
    assert.equal(standard.sizingHoles, 13);
  });

  test("a strap axis that belongs to another kind is an error, not a silent no-op", () => {
    const r = checkBuild({ ...BASE, strap: "leather", braceletType: "jubilee" });
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.slots.includes("braceletType") && i.slots.includes("strap")));
    assert.equal(checkBuild({ ...BASE, strap: "oyster", braceletType: "president" }).ok, true);
  });

  test("a curved-end rubber strap is moulded for one case profile", () => {
    const wrong = checkBuild({ ...BASE, case: "alpinist", strap: "waffle", rubberType: "curved-end" });
    assert.ok(wrong.issues.some((i) => i.slots.includes("strap") && i.level === "warning"));
    assert.equal(RUBBER_TYPES.find((r) => r.id === "curved-end").caseSpecific, true);
  });

  test("the buckle knows which strap kind it goes on", () => {
    assert.ok(BUCKLES.every((b) => Array.isArray(b.kinds) && b.kinds.length));
    assert.equal(checkBuild({ ...BASE, strap: "leather", buckle: "v-clasp" }).ok, false);
    assert.equal(checkBuild({ ...BASE, strap: "leather", buckle: "butterfly" }).ok, true);
    // The wrist holder and the exit angle the geometry needs, both flagged.
    assert.ok(WRIST_HOLDER.radiusMm >= 25 && WRIST_HOLDER.radiusMm <= 27.5);
    assert.equal(WRIST_HOLDER.material, "suede");
    assert.equal(WRIST_HOLDER.lengthApprox, true);
    assert.ok(STRAP_EXIT.degrees > 20 && STRAP_EXIT.degrees < 40);
    assert.equal(STRAP_EXIT.standoffApprox, true);
  });

  test("strap colours say which kinds they were found listed for", () => {
    for (const c of STRAP_COLOURS) {
      assert.ok(Array.isArray(c.kinds) && c.kinds.length, c.id);
      assert.ok(["very-common", "common", "uncommon", "rare"].includes(c.rarity), c.id);
    }
    assert.ok(STRAP_COLOURS.some((c) => c.id === "teal" && c.kinds.includes("nato")));
    assert.ok(HARDWARE_FINISHES.some((h) => h.id === "pvd-black"));
  });
});

// ---------------------------------------------------------------------------

describe("feedback #56 item 7 + #57: the two functions the page is built on", () => {
  test("compatibleOptions RETURNS incompatible options rather than hiding them", () => {
    // The requested philosophy, stated as a property: a dial that cannot go on
    // the chosen movement still appears, behind a warning symbol, with a reason.
    const onNh36 = compatibleOptions("dial", { ...BASE, movement: "nh36" });
    assert.equal(onNh36.length, slotOptions("dial").length, "nothing may be filtered out");
    const dateOnly = onNh36.find((o) => o.option.id === "skx-black");
    assert.equal(dateOnly.compatible, false);
    assert.ok(dateOnly.why.en && dateOnly.why.sv);
    const dayDate = onNh36.find((o) => o.option.id === "daydate-black");
    assert.equal(dayDate.compatible, true);
    assert.equal(dayDate.why, null);
  });

  test("every slot and every axis answers the same shape", () => {
    for (const slot of ALL_SLOTS) {
      const rows = compatibleOptions(slot.key, BASE);
      const expected = slotOptions(slot.key).length + (slot.optional ? 1 : 0);
      assert.equal(rows.length, expected, slot.key);
      for (const row of rows) {
        assert.ok(row.option && row.option.id, slot.key);
        assert.equal(typeof row.compatible, "boolean", slot.key);
        if (row.why === null) assert.equal(row.level, null, `${slot.key}/${row.option.id}`);
        else assert.ok(["error", "warning"].includes(row.level), `${slot.key}/${row.option.id}`);
        if (row.compatible === false) assert.equal(row.level, "error", `${slot.key}/${row.option.id}`);
      }
      // At least one option in every slot must be choosable, or the UI dead-ends.
      assert.ok(rows.some((r) => r.compatible), `${slot.key} has no compatible option at all`);
    }
    assert.deepEqual(compatibleOptions("no-such-slot", BASE), []);
  });

  test("compatibleOptions is honest about the OPTIONAL none choice", () => {
    const rings = compatibleOptions("chapterRing", { ...BASE, case: "skx013" });
    const none = rings.find((r) => r.option.id === "none");
    assert.ok(none, "an optional slot must offer none");
    assert.equal(none.compatible, false, "on the SKX013 it is not a free choice");
    const onSkx = compatibleOptions("chapterRing", { ...BASE, case: "skx007" }).find((r) => r.option.id === "none");
    assert.equal(onSkx.compatible, true);
    assert.equal(onSkx.level, "warning", "allowed, with the consequence stated");
  });

  test("feedback #57: surpriseBuild never pairs incompatible parts", () => {
    // A deterministic sequence stands in for Math.random so this is a real
    // assertion rather than a lucky one.
    for (let seed = 1; seed <= 60; seed++) {
      let s = seed;
      const rand = () => {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        return s / 0x7fffffff;
      };
      const build = surpriseBuild(rand);
      const fit = checkBuild(build);
      assert.equal(
        fit.ok, true,
        `seed ${seed}: ${fit.issues.filter((i) => i.level === "error").map((i) => i.en).join(" | ")}`,
      );
      // ...and it is a complete, decodable build, not a fragment.
      for (const slot of SLOTS) assert.ok(build[slot.key], `seed ${seed}: ${slot.key} unfilled`);
      assert.deepEqual(decodeBuild(encodeBuild(build)), build, `seed ${seed} does not round-trip`);
    }
  });

  test("surpriseBuild is deterministic for a given rand, and actually varies", () => {
    const mk = (seed) => {
      let s = seed;
      return () => {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        return s / 0x7fffffff;
      };
    };
    assert.deepEqual(surpriseBuild(mk(9)), surpriseBuild(mk(9)));
    const shapes = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((n) => JSON.stringify(surpriseBuild(mk(n)))));
    assert.ok(shapes.size >= 4, "a surprise that always returns the same watch is not one");
    // With no argument it still has to be valid — it just is not repeatable.
    assert.equal(checkBuild(surpriseBuild()).ok, true);
  });
});

// ---------------------------------------------------------------------------

describe("the wire surfaces stay backward compatible", () => {
  test("a permalink from the old eleven-slot catalogue decodes unchanged", () => {
    const legacy = "movement:nh35;case:skx007;finish:brushed;insert:ceramic-black;dial:skx-black;"
      + "chapterRing:black-minutes;hands:skx-dive;crystal:dd-sapphire;crown:signed-screw;"
      + "caseback:solid-engraved;strap:oyster";
    assert.deepEqual(decodeBuild(legacy), BASE);
    // A build that touches none of the new controls encodes to that same string.
    assert.equal(encodeBuild(BASE), legacy);
  });

  test("axis and text keys appear only once they are set", () => {
    assert.deepEqual(Object.keys(BASE), SLOTS.map((s) => s.key));
    const withAxis = normalizeBuild({ ...BASE, dialColor: "green" });
    assert.equal(Object.keys(withAxis).length, SLOTS.length + 1);
    assert.ok(encodeBuild(withAxis).includes("dialColor:green"));
    assert.deepEqual(decodeBuild(encodeBuild(withAxis)), withAxis);
    // An axis set back to its default drops out again, so the codec is stable.
    assert.deepEqual(normalizeBuild({ ...withAxis, dialColor: "as-listed" }), BASE);
    // An unknown axis value degrades to the default rather than sticking.
    assert.deepEqual(normalizeBuild({ ...BASE, dialColor: "chartreuse" }), BASE);
  });

  test("GET /api/watch/catalog still answers the shape it always did", async () => {
    const j = await body(call(""));
    for (const key of ["movement", "movements", "platforms", "cases", "slots", "parts", "brands", "sources", "defaultBuild", "note"]) {
      assert.ok(j[key] !== undefined, `${key} disappeared from the payload`);
    }
    for (const key of ["finish", "insert", "dial", "chapterRing", "hands", "crystal", "crown", "caseback", "strap"]) {
      assert.ok(Array.isArray(j.parts[key]) && j.parts[key].length, `parts.${key}`);
    }
    assert.equal(j.slots.length, 11, "the eleven part slots are the build's shape");
    // The new material is additive and lives beside it.
    assert.ok(Array.isArray(j.axes) && j.axes.length > 10);
    assert.ok(j.axes.every((a) => a.key && a.name.en && a.name.sv && Array.isArray(a.options)));
    assert.ok(Array.isArray(j.textFields) && j.textFields.length === 5);
    assert.equal(j.aperture.inboard, "day");
    assert.equal(j.dialSpec.diaMm, 28.5);
    // Every case row now says what is in its box and whether it has a display back.
    for (const c of j.cases) {
      assert.ok(Array.isArray(c.kit.includes), c.id);
      assert.ok("display" in c.displayBack, c.id);
      assert.ok(c.defaults.caseback, c.id);
    }
  });

  test("?slot= reaches the axes too", async () => {
    const j = await body(call("?slot=dateWheel"));
    assert.equal(j.slot, "dateWheel");
    assert.ok(j.options.some((o) => o.seikoPart === "0148 141"));
  });

  test("none of the new work performs a fetch", async () => {
    // The same pin as the endpoint test above, over the functions the page
    // calls. The research happened once, offline; the shipped module authors
    // its findings as data and never talks to anyone.
    const real = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = () => {
      calls += 1;
      throw new Error("the watch catalogue must not make outbound requests");
    };
    try {
      for (const slot of ALL_SLOTS) compatibleOptions(slot.key, BASE);
      surpriseBuild(() => 0.42);
      buildSpec(BASE);
      resolveBuild({ ...BASE, dialColor: "green", dateWheel: "roulette", textLogo: "TEST" });
      checkBuild({ ...BASE, case: "skx013", chapterRing: "none" });
      await body(call("?slot=leatherType"));
    } finally {
      globalThis.fetch = real;
    }
    assert.equal(calls, 0);
  });
});

// ---------------------------------------------------------------------------
// STRAP AND BRACELET GEOMETRY (feedback #56).
//
// The core's own suite (public/js/watch-core.test.js) already pins that every
// mesh is well formed. What is pinned HERE is the three things #56 actually
// complained about, which are properties no "is it finite" check can catch:
// that the families are structurally DIFFERENT from each other, that the strap
// leaves the lug already bending down onto a wrist that now exists, and that
// the run ends in a buckle or a clasp of the right width.
//
// The geometry is imported from the core rather than the façade because these
// builders are geometry, not endpoint surface; src/facade-contract.test.js
// covers what src/watch.js does re-export.

import {
  SOURCES as CORE_SOURCES,
  CASES as CORE_CASES,
  STRAP_GEOMETRY,
  STRAP_DRAPE,
  BUCKLE_STOCK,
  strapPlan,
  strapPath,
  lugAnchor,
  strapMesh,
  strapHardwareMesh,
  strapAssembly,
  strapMaterialHint,
  wristMesh,
  cushionPenetration,
  buildMeshes as coreBuildMeshes,
} from "../public/js/watch-core.js";

const SKX = CORE_CASES[0];

/**
 * Signed volume: positive means the surface is wound outward, which is what
 * back-face culling in the renderer needs. A mesh built inside out is
 * invisible, and invisible is indistinguishable from missing.
 * @param {any} m
 */
function signedVolume(m) {
  let v = 0;
  for (let i = 0; i < m.indices.length; i += 3) {
    /** @param {number} k */
    const g = (k) => [m.positions[k * 3], m.positions[k * 3 + 1], m.positions[k * 3 + 2]];
    const [a, b, c] = [g(m.indices[i]), g(m.indices[i + 1]), g(m.indices[i + 2])];
    v +=
      (a[0] * (b[1] * c[2] - b[2] * c[1]) -
        a[1] * (b[0] * c[2] - b[2] * c[0]) +
        a[2] * (b[0] * c[1] - b[1] * c[0])) /
      6;
  }
  return v;
}

/** @param {any} m */
function bounds(m) {
  const b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (let i = 0; i < m.positions.length; i += 3) {
    b.minX = Math.min(b.minX, m.positions[i]);
    b.maxX = Math.max(b.maxX, m.positions[i]);
    b.minY = Math.min(b.minY, m.positions[i + 1]);
    b.maxY = Math.max(b.maxY, m.positions[i + 1]);
    b.minZ = Math.min(b.minZ, m.positions[i + 2]);
    b.maxZ = Math.max(b.maxZ, m.positions[i + 2]);
  }
  return b;
}

describe("strap construction data", () => {
  test("every family names a real source and admits it is a listing", () => {
    for (const [id, row] of Object.entries(STRAP_GEOMETRY)) {
      assert.ok(CORE_SOURCES[row.src], `${id} names unknown source ${row.src}`);
      // No aftermarket seller publishes a drawing of a bracelet, so a strap
      // dimension that claimed to be exact would be a lie.
      assert.equal(row.approx, true, `${id} must be flagged approx`);
      assert.ok(row.note && row.note.en && row.note.sv, `${id} needs an EN and a SV note`);
      assert.ok(row.thick > 0 && row.taper >= 0 && row.taper < 0.5, id);
    }
    assert.ok(CORE_SOURCES[STRAP_DRAPE.src] && STRAP_DRAPE.approx === true);
    assert.ok(CORE_SOURCES[BUCKLE_STOCK.src] && BUCKLE_STOCK.approx === true);
  });

  test("every catalogue strap has its own construction row, not the fallback", () => {
    for (const s of STRAPS) {
      assert.ok(STRAP_GEOMETRY[s.id], `${s.id} falls through to a generic strap`);
    }
  });

  test("link fractions fit inside the strap and leave room for the gaps", () => {
    for (const [id, row] of Object.entries(STRAP_GEOMETRY)) {
      if (row.build !== "links") continue;
      const filled = row.cols.reduce((/** @type {number} */ a, /** @type {any} */ c) => a + c.w, 0);
      assert.ok(filled > 0.6 && filled <= 0.95, `${id} link widths sum to ${filled}`);
      assert.ok(row.pitch > 0 && row.gap > 0 && row.gap < row.pitch, id);
    }
  });

  test("an oyster is three links and a jubilee is five, three of them rounded", () => {
    // This is the difference the feedback said was invisible, so it is the one
    // thing the data must not be allowed to drift on.
    const oyster = STRAP_GEOMETRY.oyster;
    const jubilee = STRAP_GEOMETRY.jubilee;
    assert.equal(oyster.cols.length, 3);
    assert.equal(jubilee.cols.length, 5);
    // The oyster's centre link is the wide flat one.
    assert.ok(oyster.cols[1].w > oyster.cols[0].w * 1.5);
    assert.ok(oyster.cols[1].n >= 5, "an oyster centre link is flat, not round");
    // The jubilee's three centres are small, ROUND (n = 2 is an ellipse) and
    // offset half a pitch from the outer links — the shimmer that reads as a
    // jubilee across a room.
    for (const c of jubilee.cols.slice(1, 4)) {
      assert.equal(c.n, 2, "a jubilee centre link must be rounded");
      assert.equal(c.offset, 0.5);
      assert.ok(c.w < jubilee.cols[0].w);
    }
    assert.ok(jubilee.pitch < oyster.pitch * 0.7, "a jubilee row is much shorter than an oyster row");
  });

  test("rubber, leather and NATO are not link chains at all", () => {
    assert.equal(STRAP_GEOMETRY.waffle.build, "band");
    assert.equal(STRAP_GEOMETRY.tropic.build, "band");
    assert.equal(STRAP_GEOMETRY.leather.build, "band");
    assert.equal(STRAP_GEOMETRY.mesh.build, "woven");
    assert.equal(STRAP_GEOMETRY.nato.build, "nato");
    for (const id of ["waffle", "tropic", "leather"]) {
      assert.ok(STRAP_GEOMETRY[id].relief, `${id} has no surface relief`);
    }
    // Leather is the one that thins as it tapers.
    assert.ok(STRAP_GEOMETRY.leather.thickEnd < STRAP_GEOMETRY.leather.thick * 0.7);
    // A NATO does not taper — it is one width of webbing end to end — and it
    // lifts the case off the wrist because it passes under it.
    assert.equal(STRAP_GEOMETRY.nato.taper, 0);
    assert.ok(strapPlan(SKX, { id: "nato", kind: "nato" }).underCase > 2);
    assert.equal(strapPlan(SKX, { id: "oyster", kind: "bracelet" }).underCase, 0);
  });

  test("an unknown strap degrades to its kind rather than to nothing", () => {
    assert.equal(strapPlan(SKX, { id: "no-such-strap", kind: "rubber" }).build, "band");
    assert.equal(strapPlan(SKX, { id: "no-such-strap", kind: "bracelet" }).build, "links");
    assert.equal(strapPlan(SKX, { id: "no-such-strap", kind: "??" }).build, "band");
  });
});

describe("the strap leaves the lug the way a worn strap does", () => {
  test("both arms are already dropping AT the lug tip, not running straight out", () => {
    // The regression this pins is feedback #56's "starting angles of
    // bracelet/strap is off": the old builder left the lug horizontally.
    const plan = strapPlan(SKX, STRAPS[0]);
    for (const dir of /** @type {(1 | -1)[]} */ ([1, -1])) {
      const p = strapPath(SKX, plan, dir, 0);
      const f = p.frames[0];
      assert.ok(f.ty < -0.2, `arm ${dir} leaves at ty=${f.ty}`);
      const angle = Math.atan2(-f.ty, Math.abs(f.tz));
      // It used to be pinned at 0.35–0.9 rad, which was the bug: a fixed 29.5°
      // below horizontal, lifted from STRAP_EXIT, where the taut span to the
      // cushion runs at 67–76°. Feedback #59's lug bend was the lead-in curve
      // absorbing the difference. The angle is DERIVED now, so what a test can
      // still pin is that it is steep, downward, and outward.
      assert.ok(angle > 0.9 && angle < 1.45, `arm ${dir} departs at ${angle} rad`);
      // It starts just BEHIND the lug tip — the tuck that keeps the joint
      // overlapping — and runs outward from there.
      const anchor = lugAnchor(SKX);
      assert.ok(Math.abs(f.z) < anchor.z && Math.abs(f.z) > anchor.z - 1.7);
      assert.ok(p.total > 40, "an arm has to reach round the wrist");
    }
  });

  test("the band meets the lug on every case shell, with nothing floating", () => {
    // A browser render of the old builder showed the first link detached from
    // the lug end with daylight between them, worst on the Tuna and the dress
    // cases, whose lug geometry differs most from the SKX.
    for (const c of CORE_CASES) {
      const anchor = lugAnchor(c);
      // The anchor may never be buried inside the case wall. The Tuna is the
      // case that proves the clamp is needed: its shroud is WIDER than its
      // lug-to-lug, so the raw l2l/2 anchor starts the strap inside the case.
      const wall = (c.dims.dia / 2) * outlineFor(c.shell)(Math.PI / 2);
      assert.ok(anchor.z >= wall, `${c.id}: strap starts ${wall - anchor.z} mm inside the case wall`);
      if (c.id === "tuna") assert.ok(anchor.z > c.dims.l2l / 2, "the Tuna's shroud must push the anchor out");
      else assert.equal(anchor.z, c.dims.l2l / 2, `${c.id} should anchor on its lug-to-lug`);
      for (const s of STRAPS) {
        const kit = strapAssembly(c, s, { segments: 64 });
        // Both arms must have real geometry straddling the spring-bar point.
        // Counting vertices in a small box around it rather than measuring the
        // nearest one keeps the check independent of how finely a particular
        // family's cross-section happens to be sampled.
        for (const sz of [1, -1]) {
          let hits = 0;
          for (let i = 0; i < kit.band.positions.length; i += 3) {
            if (
              Math.abs(kit.band.positions[i + 2] - sz * anchor.z) < 2 &&
              Math.abs(kit.band.positions[i + 1] - anchor.y) < 2.5
            ) {
              hits += 1;
            }
          }
          assert.ok(hits >= 4, `${c.id}/${s.id}: only ${hits} band vertices at the ${sz > 0 ? "6" : "12"} o'clock lug`);
        }
      }
    }
  });

  test("no part of any strap sinks into the cushion it is lying on", () => {
    // Since feedback #59 the cushion is not a cylinder: the watch presses a
    // print into it. So the surface a band vertex has to stay outside of is
    // `r − penetration` at that vertex's own place on the cushion, not `r`.
    // The ridge of displaced leather only pushes the surface further out, so
    // this bound is the conservative one.
    for (const s of STRAPS) {
      const kit = strapAssembly(SKX, s, { segments: 96 });
      const { r, cy } = kit.wristInfo;
      const penAt = cushionPenetration(SKX, kit.plan);
      for (let i = 0; i < kit.band.positions.length; i += 3) {
        const x = kit.band.positions[i];
        const y = kit.band.positions[i + 1] - cy;
        const z = kit.band.positions[i + 2];
        const rad = Math.hypot(z, y);
        const floor = r - penAt(x, Math.atan2(y, z));
        assert.ok(rad >= floor - 1e-6, `${s.id} band reaches radius ${rad} inside a ${floor} cushion`);
      }
    }
  });

  test("both arms still clear the bezel and reach past the lug tips", () => {
    for (const s of STRAPS) {
      const b = bounds(strapMesh(SKX, s));
      assert.ok(b.maxY < SKX.dims.thick * 0.6, `${s.id} rises to ${b.maxY}`);
      assert.ok(b.maxZ > SKX.dims.l2l / 2, `${s.id} does not reach past the +z lugs`);
      assert.ok(b.minZ < -SKX.dims.l2l / 2, `${s.id} does not reach past the −z lugs`);
      assert.ok(b.maxX <= SKX.dims.lugW, `${s.id} is wider than its lugs`);
    }
    assert.equal(strapMesh(SKX, null).positions.length, 0);
    assert.equal(strapHardwareMesh(SKX, null).positions.length, 0);
  });
});

describe("straps are built as what they are", () => {
  test("a jubilee carries far more link solids than an oyster", () => {
    // Same case, same detail: the only thing that can move the vertex count is
    // the construction, and a five-link bracelet on a half-length pitch is
    // several times the geometry of a three-link one.
    const oyster = strapMesh(SKX, STRAPS.find((s) => s.id === "oyster"), { segments: 96 });
    const jubilee = strapMesh(SKX, STRAPS.find((s) => s.id === "jubilee"), { segments: 96 });
    assert.ok(
      jubilee.positions.length > oyster.positions.length * 1.8,
      `jubilee ${jubilee.positions.length / 3} vs oyster ${oyster.positions.length / 3} vertices`,
    );
  });

  test("families the catalogue may add later already build", () => {
    // beads-of-rice, president, engineer and shark mesh have construction rows
    // waiting for the catalogue; a strap entry naming one must not fall back.
    for (const id of ["beads-of-rice", "president", "engineer", "shark-mesh"]) {
      const kit = strapAssembly(SKX, { id, kind: "bracelet", color: "#999999" }, { segments: 96 });
      assert.ok(kit.band.positions.length > 600, `${id} produced almost no geometry`);
      assert.ok(signedVolume(kit.band) > 0, `${id} is wound inside out`);
      assert.equal(kit.plan.build, STRAP_GEOMETRY[id].build);
    }
  });

  test("every strap's band, hardware and wrist are wound outward", () => {
    for (const s of STRAPS) {
      const kit = strapAssembly(SKX, s, { segments: 96 });
      assert.ok(signedVolume(kit.band) > 0, `${s.id} band is inside out`);
      assert.ok(signedVolume(kit.hardware) > 0, `${s.id} hardware is inside out`);
      assert.ok(signedVolume(kit.wrist) > 0, `${s.id} wrist cylinder is inside out`);
    }
  });

  test("no mesh can overflow the renderer's 16-bit index buffer", () => {
    for (const c of CORE_CASES) {
      for (const s of STRAPS) {
        const r = coreBuildMeshes({ case: c.id, strap: s.id }, { segments: 128 });
        for (const [name, m] of Object.entries(r.meshes)) {
          assert.ok(m.positions.length / 3 < 65536, `${c.id}/${s.id}/${name} needs 32-bit indices`);
        }
      }
    }
  });

  test("the geometry is deterministic", () => {
    const a = strapMesh(SKX, STRAPS[0], { segments: 64 });
    const b = strapMesh(SKX, STRAPS[0], { segments: 64 });
    assert.deepEqual(a.positions, b.positions);
    assert.deepEqual(a.indices, b.indices);
  });

  test("building a strap never reaches the network", () => {
    const real = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("watch-core.js must stay pure");
    };
    try {
      for (const s of STRAPS) strapAssembly(SKX, s, { segments: 48 });
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("buckles, clasps and the wrist cylinder", () => {
  test("a strap gets a buckle and a bracelet gets a clasp", () => {
    for (const s of STRAPS) {
      const kit = strapAssembly(SKX, s, { segments: 96 });
      assert.equal(kit.plan.close, s.kind === "bracelet" ? "clasp" : "buckle");
      assert.ok(kit.hardware.positions.length > 0, `${s.id} closes with nothing`);
      // The hardware sits at the bottom of the wrist, where a clasp or buckle
      // really does — not floating out at the lugs.
      const b = bounds(kit.hardware);
      assert.ok(b.maxY < -kit.wristInfo.r * 0.5, `${s.id} hardware sits at y=${b.maxY}`);
    }
  });

  test("the buckle is the width the taper leaves the strap where it sits", () => {
    const leather = STRAPS.find((s) => s.id === "leather");
    const kit = strapAssembly(SKX, leather, { segments: 96 });
    const b = bounds(kit.hardware);
    const endWidth = SKX.dims.lugW * (1 - STRAP_GEOMETRY.leather.taper);
    // The frame is the strap's width there plus the opening clearance and two
    // side bars — never the lug width, which is the mistake worth pinning.
    const expected = endWidth + 0.9 + 2 * BUCKLE_STOCK.bar;
    assert.ok(Math.abs(b.maxX - b.minX - expected) < 0.6, `buckle is ${b.maxX - b.minX} wide, wanted ${expected}`);
    assert.ok(b.maxX - b.minX < SKX.dims.lugW + 2 * BUCKLE_STOCK.bar);
  });

  test("the wrist cylinder is the default presentation and can be switched off", () => {
    const on = coreBuildMeshes({ case: "skx007", strap: "leather" }, { segments: 48 });
    assert.ok(on.meshes.wrist.positions.length > 0, "the cylinder must be on by default");
    assert.equal(on.wrist.show, true);
    const off = coreBuildMeshes({ case: "skx007", strap: "leather" }, { segments: 48, wrist: false });
    assert.equal(off.meshes.wrist.positions.length, 0);
    assert.equal(off.wrist.show, false);
    // Axis along X, centred on x = 0, and it really is the radius it reports.
    const b = bounds(on.meshes.wrist);
    assert.ok(Math.abs(b.maxX + b.minX) < 1e-9, "the cylinder is not centred on x = 0");
    assert.ok(Math.abs(b.maxX - on.wrist.len / 2) < 1e-6);
    // The barrel is a polygon, so its highest VERTEX sits a fraction under the
    // reported radius unless a ring happens to land on 12 o'clock — except
    // where the leather displaced by the case comes back up as a ridge, which
    // is allowed to stand a little proud of it (feedback #59; the contact
    // patch itself is pinned in public/js/watch-strap.test.js).
    const top = on.wrist.cy + on.wrist.r;
    assert.ok(b.maxY <= top + WRIST_HOLDER.sinkMm * WRIST_HOLDER.bulge && b.maxY > top - 0.25, `top ${b.maxY} vs ${top}`);
    // The undeformed crown stands `sinkMm` proud of where the case back rests,
    // because the watch presses INTO the cushion rather than balancing on it.
    assert.ok(Math.abs(top - WRIST_HOLDER.sinkMm) < 1, `crown ${top} vs sink ${WRIST_HOLDER.sinkMm}`);
  });

  test("a NATO lifts the watch off the wrist because it runs under the case", () => {
    const nato = coreBuildMeshes({ case: "skx007", strap: "nato" }, { segments: 48 });
    const plain = coreBuildMeshes({ case: "skx007", strap: "leather" }, { segments: 48 });
    assert.ok(nato.wrist.cy < plain.wrist.cy - 2, "the cylinder must drop by the nylon under the case");
    // Nylon really is under the case back, between the lugs.
    const m = nato.meshes.strap;
    let underCase = 0;
    for (let i = 0; i < m.positions.length; i += 3) {
      const y = m.positions[i + 1];
      if (Math.abs(m.positions[i + 2]) < 5 && y < 0 && y > nato.wrist.cy + nato.wrist.r) underCase += 1;
    }
    assert.ok(underCase > 20, "a NATO must pass under the case");
    assert.ok(bounds(m).maxY < SKX.dims.thick * 0.6);
  });

  test("the material hints say what each mesh is made of", () => {
    // Feedback #56: "leather shouldn't be shiny like a mirror". The core does
    // not shade anything, but it is the one place that knows the strap is
    // leather, so the hint is the seam.
    const leather = strapMaterialHint(STRAPS.find((s) => s.id === "leather"));
    assert.equal(leather.strap.kind, "leather");
    assert.ok(leather.strap.rough >= 0.9 && leather.strap.metal === 0);
    assert.equal(leather.strap.useCaseFinish, false);
    const rubber = strapMaterialHint(STRAPS.find((s) => s.id === "waffle"));
    assert.equal(rubber.strap.kind, "rubber");
    assert.ok(rubber.strap.metal === 0 && rubber.strap.rough > 0.5);
    assert.equal(strapMaterialHint(STRAPS.find((s) => s.id === "nato")).strap.kind, "nylon");
    // A bracelet is the only band that takes the case's own finish.
    assert.equal(strapMaterialHint(STRAPS.find((s) => s.id === "oyster")).strap.useCaseFinish, true);
    // The hardware is steel whatever the band is — no leather buckles.
    for (const s of STRAPS) {
      const h = strapMaterialHint(s).strapHardware;
      assert.equal(h.kind, "steel");
      assert.equal(h.metal, 1);
    }
    // And the cylinder is leather, which is what the feedback asked for.
    assert.equal(strapMaterialHint(STRAPS[0]).wrist.kind, "leather");
    assert.ok(strapMaterialHint(STRAPS[0]).wrist.rough > 0.9);
  });

  test("wristMesh survives a missing strap rather than throwing", () => {
    assert.ok(wristMesh(SKX, null, { segments: 32 }).positions.length > 0);
    const kit = strapAssembly(null, null);
    assert.equal(kit.band.positions.length, 0);
    assert.equal(kit.wristInfo.show, false);
  });
});

// ---------------------------------------------------------------------------
// "Surprise me" has to be BOTH valid and surprising (feedback #57).
//
// The validity half is the reported bug: picking each slot independently
// produced a build the fit check rejected about three times in four. The
// variety half is a bug found while fixing it — the first version constrained
// the FIRST slot against DEFAULT_BUILD, whose date-only dial is incompatible
// with every day-date, GMT and no-date calibre, so the movement was decided
// before the user ever pressed the button: 3000 draws, 3000 NH35s. Valid, and
// not a surprise. A default is not a decision, so the root slot is judged
// against nothing and everything after it against the slots actually chosen.

describe("surpriseBuild is valid AND varied", () => {
  /** Deterministic generator, so a failure here is reproducible. */
  const seeded = (seed) => () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  test("never returns a build the fit check rejects", () => {
    const rnd = seeded(20260731);
    for (let i = 0; i < 500; i++) {
      const build = surpriseBuild(rnd);
      const verdict = checkBuild(build);
      assert.ok(verdict.ok, `draw ${i} invalid: ${JSON.stringify(build)}`);
    }
  });

  test("reaches every movement, not just the default one", () => {
    const rnd = seeded(1234567);
    const seen = new Set();
    for (let i = 0; i < 500; i++) seen.add(surpriseBuild(rnd).movement);
    assert.equal(
      seen.size,
      MOVEMENTS.length,
      `only reached ${[...seen].join(", ")} — the root slot is being constrained by undecided ones again`,
    );
  });

  test("varies the dial rather than settling on one", () => {
    const rnd = seeded(7654321);
    const seen = new Set();
    for (let i = 0; i < 500; i++) seen.add(surpriseBuild(rnd).dial);
    // Not all 24 — some dials are genuinely reachable only from rare
    // combinations — but a picker that offers a handful is not a surprise.
    assert.ok(seen.size >= 12, `only ${seen.size} distinct dials over 500 draws`);
  });
});
