// Unit suite for the NHxx watch builder's pure core.
//
// Three things are worth testing here and one is not. WORTH TESTING: the
// catalogue's own integrity (every id unique, every reference resolvable,
// every dimension traceable to a source), the compatibility engine (it exists
// to stop someone ordering a dated dial for a no-date movement, so its rules
// are the feature), and the geometry builders (a mesh with a NaN in it or an
// index past the end of the vertex array is a black screen, and a black screen
// is indistinguishable from a broken page). NOT worth testing here: how any of
// it LOOKS — that is verified in a browser, which is where this project's real
// rendering bugs have always come from.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  MOVEMENTS,
  CASES,
  DIALS,
  HAND_SETS,
  INSERTS,
  CHAPTER_RINGS,
  CRYSTALS,
  CROWNS,
  CASEBACKS,
  STRAPS,
  FINISHES,
  PLATFORMS,
  SLOTS,
  SOURCES,
  ALI_BRANDS,
  LUMES,
  HAND_TUBES,
  DIAL_DIA,
  DEFAULT_BUILD,
  HAND_SHAPES,
  slotOptions,
  part,
  normalizeBuild,
  resolveBuild,
  checkBuild,
  buildSpec,
  priceBand,
  sourcingFor,
  caseIndex,
  aliSearchUrl,
  encodeBuild,
  decodeBuild,
  buildMeshes,
  lathe,
  cone,
  annulus,
  box,
  extrude,
  mergeMesh,
  outlineFor,
  caseProfile,
  crystalMesh,
  strapMesh,
  handOutline,
  dialLayout,
  bezelLayout,
  mm,
} from "./watch-core.js";

const ALL_LISTS = {
  movement: MOVEMENTS,
  case: CASES,
  finish: FINISHES,
  insert: INSERTS,
  dial: DIALS,
  chapterRing: CHAPTER_RINGS,
  hands: HAND_SETS,
  crystal: CRYSTALS,
  crown: CROWNS,
  caseback: CASEBACKS,
  strap: STRAPS,
};

/** Every mesh the builder can produce, for the structural checks. */
function meshesOf(build) {
  const r = buildMeshes(build, { segments: 24 });
  return [...Object.entries(r.meshes), ...r.hands.map((h) => [`hand:${h.id}`, h.mesh])];
}

// ---------------------------------------------------------------------------

describe("catalogue integrity", () => {
  test("every slot resolves to a non-empty option list", () => {
    for (const slot of SLOTS) {
      const opts = slotOptions(slot.key);
      assert.ok(opts.length > 0, `${slot.key} has no options`);
      assert.ok(ALL_LISTS[slot.key], `${slot.key} missing from the test's list map`);
      assert.equal(opts, ALL_LISTS[slot.key]);
    }
  });

  test("ids are unique within every list", () => {
    for (const [key, list] of Object.entries(ALL_LISTS)) {
      const ids = list.map((o) => o.id);
      assert.equal(new Set(ids).size, ids.length, `duplicate id in ${key}`);
    }
  });

  test("every option carries an EN and a SV name", () => {
    for (const [key, list] of Object.entries(ALL_LISTS)) {
      for (const o of list) {
        assert.ok(o.name && typeof o.name.en === "string" && o.name.en, `${key}/${o.id} has no EN name`);
        assert.ok(o.name && typeof o.name.sv === "string" && o.name.sv, `${key}/${o.id} has no SV name`);
      }
    }
  });

  test("every bilingual blurb, note and warning carries both languages", () => {
    // Swedish is carried at the same breadth as English everywhere in this
    // project (CLAUDE.md invariant 6). A catalogue is the easiest place for a
    // half-translated entry to slip in, so it gets checked mechanically.
    const visit = (obj, path) => {
      if (!obj || typeof obj !== "object") return;
      if (Array.isArray(obj)) {
        obj.forEach((v, i) => visit(v, `${path}[${i}]`));
        return;
      }
      const keys = Object.keys(obj);
      if (keys.includes("en") || keys.includes("sv")) {
        assert.ok(typeof obj.en === "string" && obj.en.trim(), `${path} missing EN`);
        assert.ok(typeof obj.sv === "string" && obj.sv.trim(), `${path} missing SV`);
        return;
      }
      for (const k of keys) visit(obj[k], `${path}.${k}`);
    };
    for (const [key, list] of Object.entries(ALL_LISTS)) {
      list.forEach((o) => visit(o, `${key}/${o.id}`));
    }
    SLOTS.forEach((s) => visit(s.name, `slot/${s.key}`));
    Object.values(PLATFORMS).forEach((p) => visit(p.name, `platform/${p.id}`));
    Object.values(LUMES).forEach((l) => visit(l.name, "lume"));
    ALI_BRANDS.forEach((b) => visit(b.known, `brand/${b.id}`));
  });

  test("every case names a platform that exists and a source that exists", () => {
    for (const c of CASES) {
      assert.ok(PLATFORMS[c.platform], `${c.id} names unknown platform ${c.platform}`);
      assert.ok(SOURCES[c.src], `${c.id} names unknown source ${c.src}`);
    }
  });

  test("every case dimension is a plausible number of millimetres", () => {
    // Not a style check: a transposed digit here is a rendered watch the size
    // of a dinner plate, and the render is generated FROM these numbers.
    for (const c of CASES) {
      const d = c.dims;
      assert.ok(d.dia >= 30 && d.dia <= 55, `${c.id} diameter ${d.dia}`);
      assert.ok(d.l2l >= 35 && d.l2l <= 56, `${c.id} lug-to-lug ${d.l2l}`);
      assert.ok(d.thick >= 8 && d.thick <= 20, `${c.id} thickness ${d.thick}`);
      assert.ok([18, 19, 20, 22, 24].includes(d.lugW), `${c.id} lug width ${d.lugW}`);
      // The dial has to fit inside the case, with the movement's casing
      // diameter inside that.
      assert.ok(d.dia > DIAL_DIA + 3, `${c.id} is too small for a ${DIAL_DIA} mm dial`);
    }
  });

  test("every case's crystal is smaller than its case and larger than its dial", () => {
    for (const c of CASES) {
      const plat = PLATFORMS[c.platform];
      const crystal = c.crystal ? c.crystal.dia : plat.crystalDia;
      assert.ok(crystal > 0, `${c.id} has no crystal diameter`);
      assert.ok(crystal < c.dims.dia, `${c.id} crystal ${crystal} ≥ case ${c.dims.dia}`);
      assert.ok(crystal >= DIAL_DIA - 1.5, `${c.id} crystal ${crystal} too small for the dial`);
    }
  });

  test("the Tuna is the case whose lug-to-lug is SHORTER than its diameter", () => {
    // A regression guard on a fact that looks like a typo: a shrouded Tuna is
    // 47 mm across but only 44.5 mm lug to lug, which is why it wears smaller
    // than the number. Anyone "fixing" that has broken the catalogue.
    const tuna = CASES.find((c) => c.id === "tuna");
    assert.ok(tuna);
    assert.ok(tuna.dims.l2l < tuna.dims.dia);
  });

  test("every part that quotes a price quotes a sane band", () => {
    for (const [key, list] of Object.entries(ALL_LISTS)) {
      for (const o of list) {
        if (!o.ali || !o.ali.priceUsd) continue;
        const [lo, hi] = o.ali.priceUsd;
        assert.ok(lo > 0 && hi > lo && hi < 400, `${key}/${o.id} band ${lo}-${hi}`);
      }
    }
  });

  test("every AliExpress query produces a well-formed search URL", () => {
    for (const [key, list] of Object.entries(ALL_LISTS)) {
      for (const o of list) {
        for (const q of (o.ali && o.ali.queries) || []) {
          const url = aliSearchUrl(q);
          assert.match(url, /^https:\/\/www\.aliexpress\.com\/w\/wholesale-[a-z0-9-]+\.html$/, `${key}/${o.id}: ${url}`);
        }
      }
    }
  });

  test("aliSearchUrl degrades rather than producing a broken link", () => {
    assert.equal(aliSearchUrl(""), "https://www.aliexpress.com/");
    assert.equal(aliSearchUrl("   !!!  "), "https://www.aliexpress.com/");
    assert.equal(aliSearchUrl("NH35 Case!"), "https://www.aliexpress.com/w/wholesale-nh35-case.html");
  });

  test("hand sets reference shapes the geometry builder knows", () => {
    for (const hs of HAND_SETS) {
      for (const [key, shape] of Object.entries(hs.shapes)) {
        assert.ok(HAND_SHAPES.includes(shape), `${hs.id}.${key} = ${shape} is not a known outline`);
        assert.ok(typeof hs.len[key] === "number", `${hs.id}.${key} has no length`);
      }
    }
  });

  test("every dial and insert names a lume compound that exists", () => {
    for (const d of DIALS) assert.ok(LUMES[d.lume], `${d.id} lume ${d.lume}`);
    for (const i of INSERTS) {
      if (i.pip && i.pip !== "none") assert.ok(LUMES[i.pip], `${i.id} pip ${i.pip}`);
    }
  });

  test("ring parts only claim to fit platforms that exist", () => {
    for (const list of [INSERTS, CHAPTER_RINGS, CRYSTALS]) {
      for (const o of list) {
        for (const p of o.fits) assert.ok(PLATFORMS[p], `${o.id} claims platform ${p}`);
      }
    }
  });

  test("the movement family shares one hand-tube spec", () => {
    assert.deepEqual(HAND_TUBES, { hour: 1.5, minute: 0.9, second: 0.2 });
    for (const m of MOVEMENTS) assert.equal(m.dia, 27.4, `${m.id} movement diameter`);
  });
});

// ---------------------------------------------------------------------------

describe("build normalisation and the permalink codec", () => {
  test("the default build is complete and every id resolves", () => {
    for (const slot of SLOTS) {
      assert.ok(DEFAULT_BUILD[slot.key], `default build has no ${slot.key}`);
      assert.ok(part(slot.key, DEFAULT_BUILD[slot.key]), `default ${slot.key} does not resolve`);
    }
  });

  test("normalizeBuild fills every slot, whatever it is handed", () => {
    for (const input of [null, undefined, {}, { case: "nope" }, { case: 7 }, "junk"]) {
      const b = normalizeBuild(/** @type {any} */ (input));
      for (const slot of SLOTS) assert.ok(part(slot.key, b[slot.key]), `${slot.key} unresolved for ${String(input)}`);
    }
  });

  test("an unknown id falls back to the default rather than throwing", () => {
    const b = normalizeBuild({ ...DEFAULT_BUILD, dial: "no-such-dial" });
    assert.equal(b.dial, DEFAULT_BUILD.dial);
    assert.equal(b.case, DEFAULT_BUILD.case);
  });

  test("encode → decode round-trips every catalogue entry", () => {
    for (const c of CASES) {
      for (const d of DIALS) {
        const b = normalizeBuild({ ...DEFAULT_BUILD, case: c.id, dial: d.id });
        assert.deepEqual(decodeBuild(encodeBuild(b)), b);
      }
    }
  });

  test("a stale or hostile permalink decodes to something renderable", () => {
    // The whole point of the codec's fail-soft posture: a link from an older
    // catalogue must still open the page.
    for (const code of ["", ";;;", "case:gone;dial:vanished", "case", ":::", "a:b;c:d"]) {
      const b = decodeBuild(code);
      for (const slot of SLOTS) assert.ok(part(slot.key, b[slot.key]));
    }
  });

  test("resolveBuild returns catalogue objects, not ids", () => {
    const { ids, parts } = resolveBuild(DEFAULT_BUILD);
    assert.equal(ids.case, "skx007");
    assert.equal(parts.case.id, "skx007");
    assert.equal(parts.movement.caliber, "NH35A");
  });
});

// ---------------------------------------------------------------------------

describe("compatibility engine", () => {
  test("a dated movement under a no-date dial is an ERROR", () => {
    const r = checkBuild({ ...DEFAULT_BUILD, movement: "nh35", dial: "62mas-cream" });
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.level === "error" && i.slot === "dial"));
  });

  test("a no-date movement under a dated dial is an ERROR", () => {
    const r = checkBuild({ ...DEFAULT_BUILD, movement: "nh70", dial: "skx-black" });
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.level === "error" && i.slot === "movement"));
  });

  test("the NH36 needs a day window and the NH35 must not have one", () => {
    assert.equal(checkBuild({ ...DEFAULT_BUILD, movement: "nh36", dial: "skx-black" }).ok, false);
    assert.equal(checkBuild({ ...DEFAULT_BUILD, movement: "nh35", dial: "daydate-black" }).ok, false);
    assert.equal(checkBuild({ ...DEFAULT_BUILD, movement: "nh36", dial: "daydate-black" }).ok, true);
  });

  test("the NH34 needs a fourth hand", () => {
    const three = checkBuild({ ...DEFAULT_BUILD, movement: "nh34", dial: "gmt-black", hands: "skx-dive" });
    assert.equal(three.ok, false);
    assert.ok(three.issues.some((i) => i.slot === "hands" && i.level === "error"));
    const four = checkBuild({ ...DEFAULT_BUILD, movement: "nh34", dial: "gmt-black", hands: "gmt-arrow", insert: "gmt-24" });
    assert.equal(four.ok, true);
  });

  test("a GMT movement with no 24-hour scale anywhere is a warning, not an error", () => {
    const r = checkBuild({ ...DEFAULT_BUILD, movement: "nh34", dial: "skx-black", hands: "gmt-arrow", insert: "ceramic-black" });
    assert.ok(r.issues.some((i) => i.level === "warning" && i.slot === "insert"));
  });

  test("a part built for another platform is an ERROR on a shared platform", () => {
    // The SKX013 platform has no Batman insert; asking for one must not be
    // waved through, because the part physically will not seat.
    const r = checkBuild({ ...DEFAULT_BUILD, case: "mini-turtle", insert: "batman" });
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.level === "error" && i.slot === "insert"));
  });

  test("a case-specific platform downgrades fitment to a sourcing NOTE", () => {
    // A 62MAS takes its own insert and rehaut, sold with the case. That is a
    // fact about where to buy the part, not a reason to block the build.
    const r = checkBuild({ ...DEFAULT_BUILD, case: "62mas", insert: "batman" });
    assert.equal(r.ok, true);
    assert.ok(r.issues.some((i) => i.level === "note" && i.slot === "insert"));
  });

  test("a case with no rotating bezel warns that the insert is not fitted", () => {
    const r = checkBuild({ ...DEFAULT_BUILD, case: "explorer", insert: "pepsi" });
    assert.ok(r.issues.some((i) => i.level === "warning" && i.slot === "insert"));
  });

  test("issues are bilingual and correctly levelled", () => {
    for (const c of CASES) {
      for (const m of MOVEMENTS) {
        for (const i of checkBuild({ ...DEFAULT_BUILD, case: c.id, movement: m.id }).issues) {
          assert.ok(["error", "warning", "note"].includes(i.level));
          assert.ok(i.en && i.sv, `${c.id}/${m.id} issue not bilingual`);
          assert.notEqual(i.en, i.sv, `${c.id}/${m.id} issue is untranslated`);
          assert.ok(SLOTS.some((s) => s.key === i.slot), `issue names unknown slot ${i.slot}`);
        }
      }
    }
  });

  test("checkBuild never throws, whatever it is handed", () => {
    for (const input of [null, undefined, {}, { case: "??" }, "x"]) {
      assert.doesNotThrow(() => checkBuild(/** @type {any} */ (input)));
    }
  });

  test("ok is exactly 'no errors'", () => {
    for (const c of CASES) {
      for (const d of DIALS) {
        const r = checkBuild({ ...DEFAULT_BUILD, case: c.id, dial: d.id });
        assert.equal(r.ok, !r.issues.some((i) => i.level === "error"));
      }
    }
  });
});

// ---------------------------------------------------------------------------

describe("spec sheet", () => {
  test("the SKX007 spec matches the catalogue and the SKX platform", () => {
    const s = buildSpec(DEFAULT_BUILD);
    assert.equal(s.caseDia, 42.5);
    assert.equal(s.l2l, 46);
    assert.equal(s.lugW, 22);
    assert.equal(s.dialDia, 28.5);
    assert.equal(s.crystalDia, 31.5);
    assert.deepEqual(s.insert, { od: 38, id: 31.8 });
    assert.equal(s.movement, "NH35A");
    assert.equal(s.crownHour, 4);
  });

  test("a case-specific case reports its own crystal, not the platform's", () => {
    const s = buildSpec({ ...DEFAULT_BUILD, case: "62mas" });
    assert.equal(s.crystalDia, 30.5);
    assert.equal(s.insert, null);
  });

  test("a display case back and a tall crystal both raise the height budget", () => {
    const base = buildSpec({ ...DEFAULT_BUILD, crystal: "flat-sapphire", caseback: "solid-engraved" });
    const tall = buildSpec({ ...DEFAULT_BUILD, crystal: "box-sapphire", caseback: "display" });
    assert.ok(tall.stackMm > base.stackMm);
  });

  test("the price band sums the chosen parts and always includes a movement", () => {
    const band = priceBand(normalizeBuild(DEFAULT_BUILD));
    assert.ok(band.low > 0 && band.high > band.low);
    // Every slot that carries a band, plus the movement itself.
    assert.ok(band.parts >= 8);
    const cheap = priceBand(normalizeBuild({ ...DEFAULT_BUILD, case: "skx007", crystal: "domed-hardlex" }));
    const dear = priceBand(normalizeBuild({ ...DEFAULT_BUILD, case: "mm300", crystal: "box-sapphire" }));
    assert.ok(dear.high > cheap.high);
  });

  test("buildSpec never throws and always returns finite millimetres", () => {
    for (const c of CASES) {
      const s = buildSpec({ ...DEFAULT_BUILD, case: c.id });
      for (const k of ["caseDia", "l2l", "thick", "lugW", "dialDia", "crystalDia", "stackMm", "domeMm"]) {
        assert.ok(Number.isFinite(s[k]), `${c.id}.${k} = ${s[k]}`);
      }
    }
  });

  test("mm() marks approximate figures and rounds", () => {
    assert.equal(mm(42.5), "42.5 mm");
    assert.equal(mm(13.249), "13.25 mm");
    assert.equal(mm(41, true), "≈41 mm");
  });
});

// ---------------------------------------------------------------------------

describe("the AliExpress source index", () => {
  test("sourcing covers every slot that carries an index, in slot order", () => {
    const rows = sourcingFor(DEFAULT_BUILD);
    const order = rows.map((r) => r.slot);
    const expected = SLOTS.map((s) => s.key).filter((k) => order.includes(k));
    assert.deepEqual(order, expected);
    assert.ok(rows.length >= 8);
  });

  test("every sourcing row carries resolvable links and a bilingual name", () => {
    for (const c of CASES) {
      for (const row of sourcingFor({ ...DEFAULT_BUILD, case: c.id })) {
        assert.ok(row.name.en && row.name.sv);
        assert.ok(row.slotName.en && row.slotName.sv);
        for (const l of row.links) {
          assert.ok(l.q && l.url.startsWith("https://www.aliexpress.com/"));
        }
      }
    }
  });

  test("the case index exposes every case with its source URL", () => {
    const idx = caseIndex();
    assert.equal(idx.length, CASES.length);
    for (const row of idx) {
      assert.ok(row.dims && row.ali);
      assert.ok(SOURCES[row.src]);
      assert.equal(row.srcUrl, SOURCES[row.src].url || "");
      assert.ok(row.ali.links.length > 0, `${row.id} has no search links`);
    }
  });

  test("the brand table is well formed", () => {
    for (const b of ALI_BRANDS) {
      assert.ok(b.id && b.name);
      assert.ok(["premium", "mid", "budget"].includes(b.tier), `${b.id} tier ${b.tier}`);
    }
    // Every brand a case names must exist in the table, so the UI can never
    // show a brand with no description behind it.
    const known = new Set(ALI_BRANDS.map((b) => b.name));
    for (const c of CASES) {
      for (const brand of c.ali.brands) assert.ok(known.has(brand), `${c.id} names unknown brand ${brand}`);
    }
  });
});

// ---------------------------------------------------------------------------

describe("geometry builders", () => {
  /** @param {{positions:number[],normals:number[],uvs:number[],indices:number[]}} m */
  function assertWellFormed(m, label) {
    assert.equal(m.positions.length % 3, 0, `${label}: positions not a multiple of 3`);
    assert.equal(m.normals.length, m.positions.length, `${label}: normal count`);
    assert.equal(m.uvs.length, (m.positions.length / 3) * 2, `${label}: uv count`);
    assert.equal(m.indices.length % 3, 0, `${label}: indices not triangles`);
    const verts = m.positions.length / 3;
    for (const v of m.positions) assert.ok(Number.isFinite(v), `${label}: non-finite position`);
    for (const v of m.normals) assert.ok(Number.isFinite(v), `${label}: non-finite normal`);
    for (const i of m.indices) {
      assert.ok(Number.isInteger(i) && i >= 0 && i < verts, `${label}: index ${i} out of ${verts}`);
    }
    // 16-bit indices are what the renderer uploads; a mesh past 65 535
    // vertices would silently wrap and draw garbage.
    assert.ok(verts <= 65535, `${label}: ${verts} vertices exceeds the 16-bit index limit`);
    // Every normal is a unit vector, or the lighting is wrong everywhere.
    for (let i = 0; i < m.normals.length; i += 3) {
      const len = Math.hypot(m.normals[i], m.normals[i + 1], m.normals[i + 2]);
      assert.ok(Math.abs(len - 1) < 1e-6, `${label}: normal length ${len}`);
    }
  }

  test("lathe produces a well-formed surface of revolution", () => {
    const m = lathe([{ r: 0, y: 0 }, { r: 5, y: 0 }, { r: 5, y: 3 }, { r: 0, y: 3 }], 32);
    assertWellFormed(m, "lathe");
    assert.ok(m.indices.length > 0);
  });

  test("lathe degrades to an empty mesh rather than throwing on bad input", () => {
    for (const [profile, seg] of /** @type {any[][]} */ ([[[], 32], [[{ r: 1, y: 0 }], 32], [null, 32], [[{ r: 0, y: 0 }, { r: 1, y: 1 }], 2]])) {
      const m = lathe(profile, seg);
      assert.equal(m.positions.length, 0);
      assert.equal(m.indices.length, 0);
    }
  });

  test("a smooth profile point shares its normal across the crease", () => {
    // The dome/crease distinction is what makes a crystal look domed and a
    // case flank look machined; if `s` stopped working, everything would go
    // faceted and nobody would get a test failure.
    const crease = lathe([{ r: 5, y: 0 }, { r: 5, y: 3 }, { r: 0, y: 3 }], 8);
    const smooth = lathe([{ r: 5, y: 0 }, { r: 5, y: 3, s: true }, { r: 0, y: 3 }], 8);
    const nAt = (m, i) => [m.normals[i * 3], m.normals[i * 3 + 1], m.normals[i * 3 + 2]];
    // Ring 1 is the end of band 0; ring 2 is the start of band 1, at the same
    // profile point. Creased: different normals. Smooth: identical.
    const cols = 9;
    assert.notDeepEqual(nAt(crease, cols), nAt(crease, 2 * cols));
    const a = nAt(smooth, cols);
    const b = nAt(smooth, 2 * cols);
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(a[k] - b[k]) < 1e-9);
  });

  test("annulus, cone, box and extrude are well formed", () => {
    assertWellFormed(annulus(2, 5, 1, 24), "annulus");
    assertWellFormed(cone(2, 0, 5, 1, 24), "cone");
    assertWellFormed(box(2, 3, 4, [1, 2, 3]), "box");
    assertWellFormed(extrude(handOutline("sword", 10, 1), 0.3, 2), "extrude");
  });

  test("box is centred where it is asked to be and has the right extents", () => {
    const m = box(2, 4, 6, [10, 20, 30]);
    const xs = [], ys = [], zs = [];
    for (let i = 0; i < m.positions.length; i += 3) {
      xs.push(m.positions[i]);
      ys.push(m.positions[i + 1]);
      zs.push(m.positions[i + 2]);
    }
    assert.equal(Math.min(...xs), 9);
    assert.equal(Math.max(...xs), 11);
    assert.equal(Math.min(...ys), 18);
    assert.equal(Math.max(...ys), 22);
    assert.equal(Math.min(...zs), 27);
    assert.equal(Math.max(...zs), 33);
    assert.equal(m.indices.length / 3, 12, "a box is twelve triangles");
  });

  test("extrude refuses a degenerate outline instead of emitting junk", () => {
    for (const o of /** @type {any[]} */ ([null, [], [[0, 0]], [[0, 0], [1, 1]]])) {
      assert.equal(extrude(o, 1, 0).positions.length, 0);
    }
  });

  test("mergeMesh offsets indices so the parts stay separate solids", () => {
    const a = box(1, 1, 1, [0, 0, 0]);
    const before = a.positions.length / 3;
    const b = box(1, 1, 1, [5, 0, 0]);
    mergeMesh(a, b);
    assert.equal(a.positions.length / 3, before * 2);
    assert.equal(Math.max(...a.indices), before * 2 - 1);
    assertWellFormed(a, "merged");
  });

  test("the outline modulation is round for a diver and non-round for a cushion", () => {
    const round = outlineFor("diver");
    for (const t of [0, 0.4, 1.2, 3.0, 5.5]) assert.equal(round(t), 1);
    const cushion = outlineFor("cushion");
    // A superellipse is widest at the corners (45°) and unit at the axes.
    assert.ok(Math.abs(cushion(0) - 1) < 1e-9);
    assert.ok(cushion(Math.PI / 4) > 1.1, "cushion corners must bulge");
    for (const shell of ["diver", "cushion", "tonneau", "shroud", "dress", "field"]) {
      for (let t = 0; t < 7; t += 0.3) {
        const k = outlineFor(shell)(t);
        assert.ok(Number.isFinite(k) && k > 0.6 && k < 1.7, `${shell} at ${t} = ${k}`);
      }
    }
  });

  test("the case profile spans the catalogue's thickness and crystal", () => {
    for (const c of CASES) {
      const geo = caseProfile(c, CRYSTALS[0]);
      const rs = geo.profile.map((p) => p.r);
      const ys = geo.profile.map((p) => p.y);
      assert.ok(Math.min(...ys) >= 0, `${c.id} profile dips below the case back`);
      assert.ok(Math.max(...ys) <= c.dims.thick, `${c.id} profile is taller than the case`);
      assert.ok(Math.max(...rs) <= c.dims.dia / 2 + 1e-9, `${c.id} profile is wider than the case`);
      assert.ok(geo.crystalR > 0 && geo.crystalR < c.dims.dia / 2, `${c.id} crystal radius`);
      assert.ok(geo.dialY > 0 && geo.dialY < geo.bezelTopY, `${c.id} dial sits above the bezel`);
    }
  });

  test("a taller crystal makes a taller dome", () => {
    const flat = caseProfile(CASES[0], CRYSTALS.find((c) => c.id === "flat-sapphire"));
    const boxed = caseProfile(CASES[0], CRYSTALS.find((c) => c.id === "box-sapphire"));
    assert.ok(boxed.domeH > flat.domeH * 1.5);
  });

  test("crystalMesh rises from the seat to the dome height", () => {
    const m = crystalMesh(15, 10, 3, 32);
    assertWellFormed(m, "crystal");
    const ys = [];
    for (let i = 1; i < m.positions.length; i += 3) ys.push(m.positions[i]);
    assert.ok(Math.abs(Math.min(...ys) - 10) < 1e-6);
    assert.ok(Math.abs(Math.max(...ys) - 13) < 1e-6);
  });

  test("both strap arms curve DOWN and away from the lugs", () => {
    // The regression this pins: a sign error in the arc transform sent one arm
    // sweeping UP through the case instead of around the wrist.
    for (const strap of STRAPS) {
      const m = strapMesh(CASES[0], strap);
      assertWellFormed(m, `strap:${strap.id}`);
      let maxY = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (let i = 0; i < m.positions.length; i += 3) {
        maxY = Math.max(maxY, m.positions[i + 1]);
        minZ = Math.min(minZ, m.positions[i + 2]);
        maxZ = Math.max(maxZ, m.positions[i + 2]);
      }
      // Nothing on the strap may reach the bezel plane...
      assert.ok(maxY < CASES[0].dims.thick * 0.6, `${strap.id} rises to ${maxY}`);
      // ...and it must reach out on BOTH sides, past the lug tips.
      assert.ok(maxZ > CASES[0].dims.l2l / 2, `${strap.id} does not reach past the +z lugs`);
      assert.ok(minZ < -CASES[0].dims.l2l / 2, `${strap.id} does not reach past the −z lugs`);
    }
    assert.equal(strapMesh(CASES[0], null).positions.length, 0);
  });

  test("a hand outline is closed, scaled, and falls back rather than vanishing", () => {
    for (const shape of HAND_SHAPES) {
      const o = handOutline(shape, 12, 1);
      assert.ok(o.length >= 3, `${shape} outline too short`);
      const xs = o.map((p) => p[0]);
      assert.ok(Math.abs(Math.max(...xs) - 12) < 1e-6, `${shape} does not reach its length`);
      assert.ok(Math.min(...xs) < 0, `${shape} has no counterweight tail`);
    }
    // An unknown shape must produce a hand, not nothing — a missing hand is
    // worse than a plain one.
    assert.ok(handOutline("no-such-shape", 10, 1).length >= 3);
  });
});

// ---------------------------------------------------------------------------

describe("dial and bezel layout", () => {
  test("the SKX dial skips the marker the date window takes", () => {
    const dial = DIALS.find((d) => d.id === "skx-black");
    const l = dialLayout(dial, 14.25);
    assert.ok(!l.markers.some((m) => m.hour === 3), "3 o'clock marker must give way to the date");
    assert.equal(l.markers.length, 11);
    assert.equal(l.markers.find((m) => m.hour === 12).kind, "triangle");
    assert.equal(l.markers.find((m) => m.hour === 6).kind, "bar");
    assert.equal(l.markers.find((m) => m.hour === 1).kind, "dot");
  });

  test("a no-date dial keeps all twelve markers", () => {
    const l = dialLayout(DIALS.find((d) => d.id === "62mas-cream"), 14.25);
    assert.equal(l.markers.length, 12);
  });

  test("markers sit at their hour angle and ticks skip the five-minute marks", () => {
    const l = dialLayout(DIALS.find((d) => d.id === "explorer-369"), 14.25);
    for (const m of l.markers) {
      assert.ok(Math.abs(m.angle - (m.hour / 12) * Math.PI * 2) < 1e-12);
      assert.ok(m.len > 0 && m.wid > 0);
    }
    assert.equal(l.ticks.length, 48);
    assert.ok(!l.ticks.some((t) => t.minute % 5 === 0));
  });

  test("every dial produces a finite layout", () => {
    for (const d of DIALS) {
      const l = dialLayout(d, 14.25);
      assert.ok(l.markers.length > 0, `${d.id} has no markers`);
      for (const m of l.markers) {
        assert.ok(Number.isFinite(m.angle) && Number.isFinite(m.len) && Number.isFinite(m.wid), d.id);
      }
    }
  });

  test("a dive bezel is 60 minutes with a pip; a GMT bezel is 24 hours", () => {
    const dive = bezelLayout(INSERTS.find((i) => i.id === "ceramic-black"));
    assert.equal(dive.scale, "dive60");
    assert.equal(dive.ticks.length, 60);
    assert.deepEqual(dive.numerals.map((n) => n.value), [10, 20, 30, 40, 50]);
    assert.equal(dive.pip, true);

    const gmt = bezelLayout(INSERTS.find((i) => i.id === "gmt-24"));
    assert.equal(gmt.scale, "hours24");
    assert.equal(gmt.ticks.length, 24);
    assert.equal(gmt.numerals.length, 12);
  });

  test("a plain steel bezel has no scale, and a missing insert does not throw", () => {
    assert.equal(bezelLayout(INSERTS.find((i) => i.id === "steel-plain")).scale, "none");
    assert.equal(bezelLayout(null).scale, "none");
    assert.equal(bezelLayout(undefined).ticks.length, 0);
  });

  test("two-tone inserts are marked split so the renderer halves them", () => {
    assert.equal(bezelLayout(INSERTS.find((i) => i.id === "pepsi")).split, true);
    assert.equal(bezelLayout(INSERTS.find((i) => i.id === "ceramic-black")).split, false);
  });
});

// ---------------------------------------------------------------------------

describe("full assembly", () => {
  test("every case × every strap assembles into well-formed meshes", () => {
    for (const c of CASES) {
      for (const s of STRAPS) {
        for (const [name, m] of meshesOf({ ...DEFAULT_BUILD, case: c.id, strap: s.id })) {
          const verts = m.positions.length / 3;
          for (const v of m.positions) assert.ok(Number.isFinite(v), `${c.id}/${s.id}/${name}`);
          for (const i of m.indices) assert.ok(i >= 0 && i < verts, `${c.id}/${s.id}/${name} index`);
        }
      }
    }
  });

  test("every movement × every hand set produces the right number of hands", () => {
    for (const hs of HAND_SETS) {
      const r = buildMeshes({ ...DEFAULT_BUILD, hands: hs.id }, { segments: 16 });
      assert.equal(r.hands.length, Object.keys(hs.shapes).length, hs.id);
      const ids = r.hands.map((h) => h.id);
      // Hour first, seconds last: the stacking order they are drawn in.
      assert.equal(ids[0], "hour");
      assert.equal(ids[ids.length - 1], "second");
      for (const h of r.hands) assert.ok(h.mesh.positions.length > 0 && h.color, `${hs.id}/${h.id}`);
    }
  });

  test("hands are stacked, never coplanar", () => {
    const r = buildMeshes({ ...DEFAULT_BUILD, movement: "nh34", dial: "gmt-black", hands: "gmt-arrow" }, { segments: 16 });
    const ys = r.hands.map((h) => h.y);
    for (let i = 1; i < ys.length; i++) assert.ok(ys[i] > ys[i - 1], "each hand must sit above the last");
  });

  test("the crown is placed on the flank at the catalogue's crown hour", () => {
    for (const c of CASES) {
      const r = buildMeshes({ ...DEFAULT_BUILD, case: c.id }, { segments: 16 });
      const t = r.crownTransform;
      const radius = Math.hypot(t.x, t.z);
      assert.ok(radius > c.dims.dia / 2, `${c.id}: crown must sit outside the case wall`);
      assert.ok(radius < c.dims.dia / 2 + 4, `${c.id}: crown is floating at ${radius}`);
      const expected = (c.crown.hour / 12) * Math.PI * 2 - Math.PI / 2;
      assert.ok(Math.abs(t.angle - expected) < 1e-12, `${c.id} crown angle`);
      assert.ok(t.y > 0 && t.y < c.dims.thick, `${c.id} crown height`);
    }
  });

  test("a case with no rotating bezel gets no insert geometry", () => {
    const withBezel = buildMeshes({ ...DEFAULT_BUILD, case: "skx007" }, { segments: 16 });
    const without = buildMeshes({ ...DEFAULT_BUILD, case: "explorer" }, { segments: 16 });
    assert.ok(withBezel.meshes.insert.indices.length > 0);
    assert.equal(without.meshes.insert.indices.length, 0);
  });

  test("the rehaut is always modelled, on every platform", () => {
    // Without it the gap between the dial edge and the crystal seat renders as
    // a black void — which is what it did before this was made unconditional.
    for (const c of CASES) {
      const r = buildMeshes({ ...DEFAULT_BUILD, case: c.id }, { segments: 16 });
      assert.ok(r.meshes.chapterRing.indices.length > 0, `${c.id} has no rehaut`);
    }
  });

  test("the insert sits inside the bezel, leaving a steel rim", () => {
    const r = buildMeshes(DEFAULT_BUILD, { segments: 16 });
    assert.ok(r.insertInner < r.insertOuter);
    assert.ok(r.insertOuter < r.geo.bezelR, "the insert must not run to the case edge");
    assert.ok(r.insertInner > r.geo.crystalR, "the insert must not overlap the crystal");
  });

  test("buildMeshes tolerates a broken build", () => {
    for (const input of [null, {}, { case: "nope", dial: "nope" }]) {
      const r = buildMeshes(/** @type {any} */ (input), { segments: 16 });
      assert.ok(r.meshes.case.indices.length > 0);
      assert.ok(r.hands.length > 0);
    }
  });
});
