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
  STRAPS,
  CASES as CORE_CASES,
  STRAP_GEOMETRY,
  STRAP_DRAPE,
  BUCKLE_STOCK,
  strapPlan,
  strapPath,
  lugAnchor,
  outlineFor,
  strapMesh,
  strapHardwareMesh,
  strapAssembly,
  strapMaterialHint,
  wristMesh,
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
      assert.ok(angle > 0.35 && angle < 0.9, `arm ${dir} departs at ${angle} rad`);
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

  test("no part of any strap sinks into the wrist it is lying on", () => {
    for (const s of STRAPS) {
      const kit = strapAssembly(SKX, s, { segments: 96 });
      const { r, cy } = kit.wristInfo;
      for (let i = 0; i < kit.band.positions.length; i += 3) {
        const rad = Math.hypot(kit.band.positions[i + 2], kit.band.positions[i + 1] - cy);
        assert.ok(rad >= r - 1e-6, `${s.id} band reaches radius ${rad} inside a ${r} wrist`);
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
    // reported radius unless a ring happens to land on 12 o'clock.
    const top = on.wrist.cy + on.wrist.r;
    assert.ok(b.maxY <= top + 1e-9 && b.maxY > top - 0.25, `top ${b.maxY} vs ${top}`);
    // Its top surface sits just under the case back, so the watch rests on it.
    assert.ok(b.maxY < 0 && b.maxY > -1);
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
