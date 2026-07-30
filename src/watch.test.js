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
