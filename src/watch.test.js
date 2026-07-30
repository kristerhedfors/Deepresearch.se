// The watch builder's server façade: the endpoint, not the catalogue.
//
// The catalogue, the compatibility rules and the geometry are the core's own
// suite (public/js/watch-core.test.js), and src/facade-contract.test.js already
// proves the re-exports here ARE the core's functions rather than copies. What
// is left, and what this file covers, is the HTTP surface: the four shapes
// GET /api/watch/catalog answers in, its caching, its 404s, and — the one that
// matters most — that it never reaches the network.

import { test, describe } from "node:test";
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

/** Möller–Trumbore; the ray parameter, or null for a miss. */
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
  return t > 1e-7 ? t : null;
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

const SOLIDS = ["case", "caseback", "lugs", "crown"];

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
  markerIsApplied,
  materialFor,
  meshMaterialId,
  strapMaterialId,
  tintedF0,
} from "../public/js/watch-materials.js";
import { CRYSTALS, DIALS, INSERTS, STRAPS, FINISHES } from "./watch.js";

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
      const back = verts(buildMeshes({ ...DEFAULT_BUILD, case: c.id }, { segments: 16 }).meshes.caseback);
      const backR = Math.max(...back.map((p) => Math.hypot(p[0], p[2])));
      const backTop = Math.max(...back.map((p) => p[1]));
      assert.ok(backR >= geo.boreBotR - 1e-6, `${c.id}: the case back is narrower than the bore it has to close`);
      assert.ok(backTop >= geo.dialY - 1, `${c.id}: nothing fills the case under the dial`);
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
    assert.ok(h("dd-sapphire") > h("domed-hardlex"));
    assert.ok(h("domed-hardlex") > h("flat-sapphire"));
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
