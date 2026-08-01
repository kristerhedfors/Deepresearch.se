// Hands as DECOMPOSED AXES (feedback #59: "Same goes with hands").
//
// The dial and the strap were decomposed into orthogonal axes; hands were
// still whole named bundles. These tests cover the five axes that fixed that
// — colour, seconds-hand colour, finish, lume and length — and, at least as
// importantly, the two things a decomposition is most likely to break:
//
//   * the DEFAULT has to stay a no-op, byte for byte, so the stock SKX set
//     renders exactly the watch it always did, and
//   * a permalink minted BEFORE the axes existed has to resolve to the same
//     watch, which is what `asListed` defaults buy.
//
// They live in their own file rather than in watch-core.test.js on purpose:
// that file is the shared one, and a decomposition lands as its own slice.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  AXIS_SLOTS,
  DEFAULT_BUILD,
  DIAL_DIA,
  HAND_COLOURS,
  HAND_FINISHES,
  HAND_LENGTHS,
  HAND_LUME_OPTIONS,
  HAND_SETS,
  LUMES,
  SLOTS,
  SOURCES,
  buildMeshes,
  checkBuild,
  compatibleOptions,
  decodeBuild,
  encodeBuild,
  normalizeBuild,
  part,
  resolveBuild,
  slotOptions,
  surpriseBuild,
} from "./watch-core.js";
import { MATERIALS } from "./watch-materials.js";

/** The five axes this slice added. */
const HAND_AXES = ["handColor", "handSecondColor", "handFinish", "handLume", "handLength"];

/** The lists behind them, for the integrity sweep. */
const HAND_LISTS = {
  HAND_COLOURS,
  HAND_FINISHES,
  HAND_LUME_OPTIONS,
  HAND_LENGTHS,
};

/** @param {Record<string, string>} extra */
const build = (extra) => normalizeBuild({ ...DEFAULT_BUILD, ...extra });

/** @param {Record<string, string>} b */
const hands = (b) => resolveBuild(b).parts.hands;

/** @param {string} id */
const set = (id) => /** @type {any} */ (HAND_SETS.find((h) => h.id === id));

// ---------------------------------------------------------------------------

describe("the hand option lists", () => {
  test("every list is non-empty and its ids are unique", () => {
    for (const [name, list] of Object.entries(HAND_LISTS)) {
      assert.ok(list.length > 0, `${name} is empty`);
      const ids = list.map((o) => o.id);
      assert.equal(new Set(ids).size, ids.length, `duplicate id in ${name}`);
    }
  });

  test("invariant 6: every option carries an EN and a SV name", () => {
    for (const [name, list] of Object.entries(HAND_LISTS)) {
      for (const o of /** @type {any[]} */ (list)) {
        assert.ok(o.name && o.name.en && o.name.en.trim(), `${name}/${o.id} has no EN name`);
        assert.ok(o.name && o.name.sv && o.name.sv.trim(), `${name}/${o.id} has no SV name`);
      }
    }
  });

  test("invariant 6: every note is bilingual and actually translated", () => {
    for (const [name, list] of Object.entries(HAND_LISTS)) {
      for (const o of /** @type {any[]} */ (list)) {
        if (!o.note) continue;
        assert.ok(o.note.en && o.note.en.trim(), `${name}/${o.id} note missing EN`);
        assert.ok(o.note.sv && o.note.sv.trim(), `${name}/${o.id} note missing SV`);
        assert.notEqual(o.note.en, o.note.sv, `${name}/${o.id} note is untranslated`);
      }
    }
  });

  test("no invented millimetres: every option names a source that exists", () => {
    for (const [name, list] of Object.entries(HAND_LISTS)) {
      for (const o of /** @type {any[]} */ (list)) {
        assert.ok(o.src, `${name}/${o.id} names no source`);
        assert.ok(SOURCES[o.src], `${name}/${o.id} names unknown source ${o.src}`);
      }
    }
  });

  test("every hand colour is a hex triple and declares the roles it is sold in", () => {
    for (const c of HAND_COLOURS) {
      assert.match(c.hex, /^#[0-9a-f]{6}$/i, `${c.id} hex`);
      assert.ok(Array.isArray(c.roles) && c.roles.length, `${c.id} declares no roles`);
      for (const r of c.roles) assert.ok(["set", "second"].includes(r), `${c.id} bad role ${r}`);
    }
    // The decomposition is pointless if nothing can be a full set, and the
    // seconds-hand accent is the case the report actually named.
    assert.ok(HAND_COLOURS.some((c) => c.roles.includes("set")));
    assert.ok(HAND_COLOURS.some((c) => !c.roles.includes("set")));
  });

  test("every hand finish names a material the renderer's table actually has", () => {
    // This is the ONE line changed in watch-render.js. A finish naming a
    // material that does not exist would fall back silently to a grey.
    for (const f of HAND_FINISHES) {
      assert.ok(f.material, `${f.id} names no material`);
      assert.ok(MATERIALS[f.material], `${f.id} names unknown material ${f.material}`);
    }
    assert.equal(
      HAND_FINISHES.find((f) => f.id === "polished")?.material,
      "hands-polished",
      "the default finish must stay the renderer's own literal",
    );
  });

  test("hand lume is the dial-lume list minus the one option a hand cannot be", () => {
    const ids = HAND_LUME_OPTIONS.map((o) => o.id);
    assert.ok(ids.includes("none"), "a hand set without lume has to be sayable — that is the report");
    assert.ok(ids.includes("c3") && ids.includes("bgw9"));
    assert.ok(!ids.includes("full-lume"), "a whole glowing DIAL is not a hand");
    for (const id of ids) assert.ok(LUMES[id], `${id} is not a lume compound`);
  });

  test("hand lengths are derived from the catalogue's own dial diameters", () => {
    // No new millimetre is introduced: each row restates a DIAL_DIAMETERS row,
    // keeping that row's source and its approx flag.
    for (const l of HAND_LENGTHS) {
      assert.equal(typeof l.forDialMm, "number");
      assert.ok(l.forDialMm >= 28 && l.forDialMm <= 33, `${l.id} implausible ${l.forDialMm} mm`);
      assert.ok(Math.abs(l.scale - l.forDialMm / DIAL_DIA) < 1e-12, `${l.id} scale`);
      assert.equal(typeof l.approx, "boolean");
    }
    const standard = HAND_LENGTHS.find((l) => l.forDialMm === DIAL_DIA);
    assert.ok(standard, "the 28.5 mm standard has to be in the list");
    assert.equal(standard.scale, 1);
    assert.equal(standard.approx, false, "the standard dial size is a spec-sheet figure");
  });
});

// ---------------------------------------------------------------------------

describe("the axis rows", () => {
  test("all five hand axes are registered, over the hands slot", () => {
    for (const key of HAND_AXES) {
      const axis = AXIS_SLOTS.find((a) => a.key === key);
      assert.ok(axis, `${key} is not in AXIS_SLOTS`);
      assert.equal(axis.over, "hands", `${key} must file under the Hands row`);
      assert.equal(axis.group, "hands", `${key} group`);
      assert.ok(axis.list, `${key} names no list`);
    }
    assert.equal(
      AXIS_SLOTS.filter((a) => a.over === "hands").length,
      HAND_AXES.length,
      "an axis over hands that this test does not know about",
    );
  });

  test("every hand axis defaults to \"as the hands come\", bilingually", () => {
    for (const key of HAND_AXES) {
      const axis = /** @type {any} */ (AXIS_SLOTS.find((a) => a.key === key));
      assert.ok(axis.asListed, `${key} has no as-listed default — an old permalink would move`);
      assert.ok(axis.asListed.en && axis.asListed.sv, `${key} as-listed is not bilingual`);
      assert.notEqual(axis.asListed.en, axis.asListed.sv, `${key} as-listed is untranslated`);
      assert.ok(axis.name.en && axis.name.sv, `${key} name is not bilingual`);
      assert.notEqual(axis.name.en, axis.name.sv, `${key} name is untranslated`);
      assert.equal(axis.defaultId, undefined, `${key} must not carry an explicit default`);
    }
  });

  test("every hand axis resolves to a real option list with the as-listed head", () => {
    for (const key of HAND_AXES) {
      const opts = slotOptions(key);
      assert.ok(opts.length > 1, `${key} resolved to nothing — is it in CATALOG?`);
      assert.equal(opts[0].id, "as-listed", `${key} is missing its as-listed head`);
      assert.ok(part(key, opts[1].id), `${key}/${opts[1].id} does not resolve`);
    }
  });
});

// ---------------------------------------------------------------------------

describe("the default is a no-op", () => {
  test("an untouched build renders the hand set exactly as the catalogue lists it", () => {
    const raw = set(DEFAULT_BUILD.hands);
    const eff = hands(DEFAULT_BUILD);
    assert.equal(eff.color, raw.color);
    assert.equal(eff.secondColor, raw.secondColor);
    assert.equal(eff.lume, raw.lume);
    assert.equal(typeof eff.lume, "boolean", "the renderer switches the glow on a BOOLEAN");
    assert.deepEqual(eff.len, raw.len);
    assert.deepEqual(eff.shapes, raw.shapes);
    assert.equal(eff.material, "hands-polished", "the material the renderer used to hard-code");
    assert.equal(eff.lumeId, null);
    assert.equal(eff.lengthId, null);
    assert.equal(eff.colourId, undefined);
  });

  test("no hand set is disturbed by resolving it with no axes set", () => {
    for (const h of HAND_SETS) {
      const eff = hands(build({ hands: h.id, movement: h.gmt ? "nh34" : "nh35" }));
      assert.equal(eff.color, h.color, `${h.id} colour moved`);
      assert.equal(eff.secondColor, h.secondColor, `${h.id} seconds colour moved`);
      assert.equal(eff.gmtColor, h.gmtColor, `${h.id} gmt colour moved`);
      assert.equal(eff.lume, h.lume, `${h.id} lume moved`);
      assert.deepEqual(eff.len, h.len, `${h.id} length moved`);
      assert.equal(eff.material, "hands-polished", `${h.id} material moved`);
    }
  });

  test("the geometry a default build produces is unchanged in shape and count", () => {
    // The hands are extruded from `len` and `shapes`; if the axes leaked into
    // either, the vertex counts would move.
    const r = buildMeshes(normalizeBuild(DEFAULT_BUILD), { segments: 24 });
    assert.equal(r.hands.length, 3, "SKX dive is a three-hand set");
    for (const h of r.hands) {
      assert.ok(h.mesh.positions.length > 0, `${h.id} has no geometry`);
      assert.equal(h.color, set("skx-dive").color, `${h.id} colour`);
    }
  });
});

// ---------------------------------------------------------------------------

describe("an old permalink still resolves to the same watch", () => {
  // The whole point of `asListed`: a build that touches none of the new
  // controls has to ENCODE to the string it always did, and a string minted
  // before the axes existed has to DECODE to the same parts.
  const LEGACY = SLOTS.map((s) => `${s.key}:${DEFAULT_BUILD[s.key]}`).join(";");

  test("the default build still encodes to the eleven-slot legacy string", () => {
    assert.equal(encodeBuild(DEFAULT_BUILD), LEGACY);
    const code = encodeBuild(DEFAULT_BUILD);
    for (const key of HAND_AXES) {
      assert.ok(!code.includes(`${key}:`), `${key} leaked into a default permalink`);
    }
  });

  test("a legacy code decodes to the identical hand set", () => {
    const then = set(DEFAULT_BUILD.hands);
    const now = hands(decodeBuild(LEGACY));
    assert.equal(now.color, then.color);
    assert.equal(now.secondColor, then.secondColor);
    assert.equal(now.lume, then.lume);
    assert.deepEqual(now.len, then.len);
  });

  test("a legacy code for EVERY hand set round-trips unchanged", () => {
    for (const h of HAND_SETS) {
      const code = SLOTS.map((s) => `${s.key}:${s.key === "hands" ? h.id : DEFAULT_BUILD[s.key]}`).join(";");
      const decoded = decodeBuild(code);
      assert.equal(decoded.hands, h.id);
      assert.equal(encodeBuild(decoded), code, `${h.id} re-encoded differently`);
      for (const key of HAND_AXES) assert.equal(decoded[key], undefined, `${h.id} gained ${key}`);
    }
  });

  test("a build WITH hand axes round-trips through the codec", () => {
    const b = build({
      hands: "mercedes",
      handColor: "gold",
      handSecondColor: "red",
      handFinish: "gold-plated",
      handLume: "none",
      handLength: "31-8",
    });
    const round = decodeBuild(encodeBuild(b));
    for (const key of HAND_AXES) assert.equal(round[key], b[key], key);
    assert.deepEqual(round, b);
  });

  test("an unknown hand-axis id degrades to the default rather than throwing", () => {
    const round = decodeBuild(`${LEGACY};handColor:chartreuse;handLength:99`);
    assert.equal(round.handColor, undefined);
    assert.equal(round.handLength, undefined);
    assert.equal(hands(round).color, set(DEFAULT_BUILD.hands).color);
  });
});

// ---------------------------------------------------------------------------

describe("colour, the axis the report opened on", () => {
  test("Mercedes hands in gold: a monochrome set recolours all through", () => {
    const eff = hands(build({ hands: "mercedes", handColor: "gold" }));
    const gold = /** @type {any} */ (HAND_COLOURS.find((c) => c.id === "gold"));
    assert.equal(eff.color, gold.hex);
    assert.equal(eff.secondColor, gold.hex, "a monochrome set's seconds hand goes with it");
    assert.equal(eff.colourId, "gold");
    assert.deepEqual(eff.shapes, set("mercedes").shapes, "recolouring is not a reshape");
  });

  test("a snowflake set keeps its blue seconds hand when the set is recoloured", () => {
    // The contrast is what that set IS. Deleting it silently would be the
    // "whack" the report was about, one level down.
    const raw = set("snowflake");
    const eff = hands(build({ hands: "snowflake", handColor: "gold" }));
    assert.notEqual(eff.color, raw.color);
    assert.equal(eff.secondColor, raw.secondColor, "the contrast seconds hand must survive");
  });

  test("a snowflake set with a red seconds hand", () => {
    const raw = set("snowflake");
    const eff = hands(build({ hands: "snowflake", handSecondColor: "red" }));
    const red = /** @type {any} */ (HAND_COLOURS.find((c) => c.id === "red"));
    assert.equal(eff.secondColor, red.hex);
    assert.equal(eff.secondColourId, "red");
    assert.equal(eff.color, raw.color, "only the seconds hand moved");
  });

  test("an explicit seconds colour beats the set recolour, in either order", () => {
    const eff = hands(build({ hands: "mercedes", handColor: "gold", handSecondColor: "red" }));
    assert.equal(eff.color, "#c8a253");
    assert.equal(eff.secondColor, "#c33b32");
  });

  test("the GMT hand keeps its own accent when the set is recoloured", () => {
    const raw = set("gmt-arrow");
    const eff = hands(build({ movement: "nh34", hands: "gmt-arrow", handColor: "black" }));
    assert.equal(eff.gmtColor, raw.gmtColor);
  });

  test("a seconds-only colour on the whole set warns, and never blocks", () => {
    const res = checkBuild(build({ handColor: "red" }));
    const issue = res.issues.find((i) => i.slot === "handColor");
    assert.ok(issue, "no warning for a colour sold only as a seconds accent");
    assert.equal(issue.level, "warning");
    assert.ok(issue.slots.includes("handColor"), "the axis's own dropdown has to carry it");
    assert.ok(issue.en && issue.sv);
    assert.notEqual(issue.en, issue.sv);
    assert.ok(res.ok, "a warning must never make the build unassemblable");
    // The same colour on the SECONDS hand is exactly what it is sold for.
    assert.ok(!checkBuild(build({ handSecondColor: "red" })).issues.some((i) => i.slot === "handColor"));
  });
});

// ---------------------------------------------------------------------------

describe("finish", () => {
  test("every finish resolves to its material, and only polished is the default", () => {
    for (const f of HAND_FINISHES) {
      const eff = hands(build({ handFinish: f.id }));
      assert.equal(eff.material, f.material, `${f.id} material`);
      assert.equal(eff.finishId, f.id);
    }
    assert.equal(hands(DEFAULT_BUILD).finishId, "polished");
  });

  test("a finish sold as one product carries its colour — unless a colour is chosen", () => {
    const pvd = hands(build({ handFinish: "pvd-black" }));
    assert.equal(pvd.color, "#1b1d21", "\"PVD black hands\" is sold as a black hand");
    assert.equal(pvd.material, "pvd-black");

    const both = hands(build({ handFinish: "pvd-black", handColor: "gold" }));
    assert.equal(both.color, "#c8a253", "an explicit colour beats the finish's own");
    assert.equal(both.material, "pvd-black", "…but the surface is still the coated one");
  });

  test("plating is a polished surface, not its own material", () => {
    // Found by LOOKING: the `gold` material spec reflects more of the
    // environment than `hands-polished` (0.78 against 0.62), and a thin hand
    // facing a bright sky then washes to white — gold-plated hands came out
    // PALER than the same colour over the polished spec.
    for (const id of ["gold-plated", "rose-gold-plated"]) {
      const f = /** @type {any} */ (HAND_FINISHES.find((x) => x.id === id));
      assert.equal(f.material, "hands-polished", `${id} must stay a polished surface`);
      assert.match(f.color, /^#[0-9a-f]{6}$/i, `${id} carries the tint instead`);
    }
  });

  test("a two-colour set is drawn as lacquer, because a metal cannot show one", () => {
    // The renderer builds ONE material for the hand group and overrides only
    // the per-hand albedo; a metal has no diffuse term, so on the polished
    // spec a red seconds hand renders WHITE. Verified in the browser.
    const twoTone = hands(build({ hands: "snowflake", handSecondColor: "red" }));
    assert.notEqual(twoTone.color, twoTone.secondColor);
    assert.equal(twoTone.material, "dial-gloss");

    // A monochrome recolour needs no such thing, and keeps the mirror.
    assert.equal(hands(build({ hands: "mercedes", handColor: "gold" })).material, "hands-polished");

    // A GMT set's red 24-hour hand is the same case, and was lost the same way
    // until `twoTone` learned to look at `gmtColor` too.
    const gmt = hands(build({ movement: "nh34", hands: "gmt-arrow", handColor: "black" }));
    assert.equal(gmt.color, "#1b1d21");
    assert.equal(gmt.gmtColor, set("gmt-arrow").gmtColor);
    assert.equal(gmt.material, "dial-gloss");

    // A set whose CONTRAST it shipped with, untouched, keeps the old material.
    assert.equal(hands(build({ hands: "snowflake" })).material, "hands-polished");
    assert.equal(hands(build({ movement: "nh34", hands: "gmt-arrow" })).material, "hands-polished");

    // An explicit finish is an explicit choice and still wins.
    assert.equal(
      hands(build({ hands: "snowflake", handSecondColor: "red", handFinish: "brushed" })).material,
      "steel-brushed",
    );
  });

  test("a surface-only finish leaves the set's colour exactly where it was", () => {
    const raw = set("skx-dive");
    for (const id of ["brushed", "blasted", "polished"]) {
      const eff = hands(build({ handFinish: id }));
      assert.equal(eff.color, raw.color, `${id} moved the colour`);
    }
  });
});

// ---------------------------------------------------------------------------

describe("lume as a choosable axis", () => {
  test("lume off on a set that ships lumed", () => {
    assert.equal(set("skx-dive").lume, true);
    const eff = hands(build({ handLume: "none" }));
    assert.equal(eff.lume, false, "the renderer reads a BOOLEAN — \"none\" is truthy");
    assert.equal(eff.lumeId, "none");
  });

  test("lume on a set that ships without it", () => {
    assert.equal(set("dauphine").lume, false);
    const eff = hands(build({ hands: "dauphine", handLume: "bgw9" }));
    assert.equal(eff.lume, true);
    assert.equal(eff.lumeId, "bgw9");
  });

  test("every compound leaves `lume` a boolean", () => {
    for (const o of HAND_LUME_OPTIONS) {
      const eff = hands(build({ handLume: o.id }));
      assert.equal(typeof eff.lume, "boolean", `${o.id}`);
      assert.equal(eff.lume, o.id !== "none");
    }
  });

  test("lumed hands over a lume-less dial still raise the sourcing note", () => {
    // The rule has to fire against the EFFECTIVE hands: a set that ships
    // without lume but was given some is the case that used to be unreachable.
    const b = build({ dial: "sub-black", hands: "dauphine", handLume: "c3", dialLume: "none" });
    const dl = resolveBuild(b).parts.dial;
    assert.equal(dl.lume, "none");
    const note = checkBuild(b).issues.find((i) => i.en.includes("Lumed hands over a dial with no lume"));
    assert.ok(note, "the note did not fire against the effective hands");
    assert.ok(note.slots.includes("handLume"), "the axis's own dropdown has to carry it");
    // And the mirror: switching the hands' lume OFF makes it go away.
    assert.ok(!checkBuild({ ...b, handLume: "none" }).issues.some((i) => i.slots.includes("handLume")));
  });
});

// ---------------------------------------------------------------------------

describe("length, and the warning it finally makes reachable", () => {
  test("no listed hand set trips either length rule on its own", () => {
    // Establishes the baseline the axis changes: before it, both warnings
    // were dead code.
    for (const h of HAND_SETS) {
      const b = build({ hands: h.id, movement: h.gmt ? "nh34" : "nh35" });
      const len = checkBuild(b).issues.filter((i) => i.en.startsWith("The minute hand"));
      assert.equal(len.length, 0, `${h.id} warns with no axis set`);
    }
  });

  test("a set cut for a 31.8 mm dial overhangs the track on a 28.5 mm one", () => {
    const b = build({ handLength: "31-8" });
    const eff = hands(b);
    assert.ok(eff.len.minute > set("skx-dive").len.minute, "the hand did not get longer");
    assert.equal(eff.lengthForDialMm, 31.8);
    assert.equal(eff.lengthApprox, true, "a listing figure, not a spec sheet");
    const issue = checkBuild(b).issues.find((i) => i.en.includes("overhang the chapter ring"));
    assert.ok(issue, "the overhang warning did not fire");
    assert.ok(issue.slots.includes("handLength"));
    assert.ok(checkBuild(b).ok, "an overhang is a warning, not a blocked build");
  });

  test("the standard length is exactly the set's own", () => {
    const eff = hands(build({ handLength: "28-5" }));
    assert.deepEqual(eff.len, set("skx-dive").len);
  });

  test("scaling keeps every hand a finite positive number, and the mesh well formed", () => {
    for (const l of HAND_LENGTHS) {
      const b = build({ hands: "gmt-arrow", movement: "nh34", handLength: l.id });
      const eff = hands(b);
      for (const [k, v] of Object.entries(eff.len)) {
        assert.ok(Number.isFinite(v) && v > 0, `${l.id}/${k} is ${v}`);
      }
      const r = buildMeshes(b, { segments: 16 });
      assert.equal(r.hands.length, 4, `${l.id}: a GMT set is four hands`);
      for (const h of r.hands) {
        assert.ok(h.mesh.positions.length > 0, `${l.id}/${h.id} empty`);
        assert.ok(h.mesh.positions.every(Number.isFinite), `${l.id}/${h.id} NaN`);
      }
    }
  });
});

// ---------------------------------------------------------------------------

describe("nothing else moved", () => {
  test("the GMT rules still judge the EFFECTIVE hands", () => {
    const missing = checkBuild(build({ movement: "nh34", hands: "mercedes", handColor: "gold" }));
    assert.ok(missing.issues.some((i) => i.level === "error" && i.slot === "hands"));
    const ok = checkBuild(build({ movement: "nh34", hands: "gmt-arrow", handFinish: "pvd-black" }));
    assert.ok(!ok.issues.some((i) => i.level === "error" && i.slot === "hands"));
  });

  test("compatibleOptions answers for every hand axis, bilingually", () => {
    for (const key of HAND_AXES) {
      const rows = compatibleOptions(key, DEFAULT_BUILD);
      assert.ok(rows.length > 1, `${key} offered nothing`);
      for (const row of rows) {
        assert.ok(row.option && row.option.id, `${key} row without an option`);
        if (!row.why) continue;
        assert.ok(row.why.en && row.why.sv, `${key}/${row.option.id} reason not bilingual`);
        assert.notEqual(row.why.en, row.why.sv, `${key}/${row.option.id} reason untranslated`);
      }
    }
    // The seconds-only colour is the one that has to come back annotated.
    const red = compatibleOptions("handColor", DEFAULT_BUILD).find((r) => r.option.id === "red");
    assert.ok(red && red.why, "the seconds-only colour is not annotated in its dropdown");
    assert.equal(red.compatible, true, "warned, never blocked");
  });

  test("surpriseBuild still assembles with the axes in play", () => {
    let seed = 20260801;
    const rand = () => {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      return Math.abs(seed % 100000) / 100000;
    };
    for (let i = 0; i < 60; i++) {
      const b = surpriseBuild(rand);
      assert.ok(checkBuild(b).ok, `attempt ${i} produced an unassemblable build: ${encodeBuild(b)}`);
      const eff = hands(b);
      assert.equal(typeof eff.lume, "boolean");
      assert.ok(MATERIALS[eff.material], `unknown hand material ${eff.material}`);
    }
  });

  test("every finish × colour × set is renderable", () => {
    for (const h of HAND_SETS) {
      for (const f of HAND_FINISHES) {
        for (const c of HAND_COLOURS) {
          const b = build({ hands: h.id, movement: h.gmt ? "nh34" : "nh35", handFinish: f.id, handColor: c.id });
          const eff = hands(b);
          assert.match(eff.color, /^#[0-9a-f]{6}$/i, `${h.id}/${f.id}/${c.id}`);
          assert.match(eff.secondColor, /^#[0-9a-f]{6}$/i, `${h.id}/${f.id}/${c.id} seconds`);
          assert.ok(MATERIALS[eff.material], `${h.id}/${f.id}/${c.id} material`);
          assert.doesNotThrow(() => checkBuild(b));
        }
      }
    }
  });
});
