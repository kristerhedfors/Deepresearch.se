// Two shading defects found by LOOKING at the merged feedback-#59 work, and
// the properties that stop them coming back.
//
//   1. THE MOVEMENT RENDERED AS A WHITE BLOB. PR #361 put a real movement
//      behind the exhibition window and it came out as a near-featureless
//      disc: measured over the window in the default scene, mean 0.846 with a
//      standard deviation of 0.062. The mesh was fine and the material table
//      was doing exactly what docs/WATCH-BUILDER.md §3.1 says it does — the
//      underside was simply lit so hard that the whole subject sat on the
//      tonemap's shoulder, where a 0.52-against-0.66 reflectance difference
//      comes out as 0.813 against 0.913 and reads as nothing.
//
//   2. A LEATHER STRAP PAINTED AN INTEGRATED BRACELET BROWN. On a Royal Oak
//      or a PRX the bracelet is machined out of the case; the strap slot's
//      choice never reaches the geometry, and the renderer read it anyway.
//
// What can be tested here is the pure half: the material table's separation,
// and the resolver that decides what the band is made of. The render itself
// needs a GL context on the first line of watch-render.js, so its half is a
// SOURCE assertion plus a browser measurement — the numbers quoted above and
// below were taken with Playwright against a local server, masked to the
// window by differencing a display back against a solid one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  bandMaterialId,
  bandTakesCaseFinish,
  MATERIALS,
  materialFor,
  meshMaterialId,
} from "./watch-materials.js";

const RENDER_SRC = readFileSync(new URL("./watch-render.js", import.meta.url), "utf8");

// ---------------------------------------------------------------------------
// 1. The movement has to have somewhere to put its contrast.

test("the three movement responses are separated in BOTH of their levers", () => {
  const base = MATERIALS["movement-base"];
  const plate = MATERIALS["movement-plate"];
  const rotor = MATERIALS["movement-rotor"];
  // A conductor has no diffuse response, so the only two things that can make
  // the mainplate darker than the bridges are its reflectance and how much of
  // the room it sees. Moving one without the other is what the first tuning
  // did, and the tonemap ate the result.
  assert.ok(plate.reflect - base.reflect >= 0.3,
    `bridges must out-reflect the mainplate by a wide margin, got ${plate.reflect} vs ${base.reflect}`);
  assert.ok(plate.env / base.env >= 2,
    `the mainplate is roofed by the bridges and must see much less of the room, got ${base.env} vs ${plate.env}`);
  // …and the mainplate has to be a COATED metal's reflectance, not a bare
  // one's. Bare steel is 0.57; a blasted, oxidised plate belongs down with
  // pvd-black.
  assert.ok(base.reflect <= MATERIALS["steel-blasted"].reflect / 2,
    "the mainplate is not bare steel");
  // The rotor is the decorated part and keeps its own place between the two.
  assert.ok(rotor.aniso > 0.5, "the rotor's sweep is what tells it from a bridge");
  assert.ok(rotor.env > plate.env - 0.2, "the rotor sits on top and sees the window");
});

test("the mainplate's contrast survives the tonemap, not just the table", () => {
  // The reason the first tuning failed is worth pinning as arithmetic rather
  // than as a comment. Take the two F0 luminances the table asks for, put them
  // through the shader's own curve at the default exposure, and ask what is
  // left. On the shoulder (the underside as it was lit, ~2.4x here) almost
  // nothing survives; in the working range most of it does.
  const curve = (v, exposure) => {
    const c = Math.max(0, v) * exposure;
    const t = (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14);
    return Math.pow(Math.min(1, Math.max(0, t)), 1 / 2.2);
  };
  const base = MATERIALS["movement-base"];
  const plate = MATERIALS["movement-plate"];
  // Radiance reaching the eye, to a constant: reflectance x how much room the
  // part sees x the room's radiance.
  const lit = (m, room) => m.reflect * m.env * room;
  const spread = (room) => curve(lit(plate, room), 1.12) - curve(lit(base, room), 1.12);
  assert.ok(spread(0.8) > 0.2, `in the working range the parts must separate, got ${spread(0.8).toFixed(3)}`);
  // And the failure mode itself: pile on light and the same table says almost
  // nothing. This is a fact about the curve, so it stays true — it is here to
  // stop anyone "fixing" a flat movement by turning the lights up.
  assert.ok(spread(6) < spread(0.8) / 2,
    "over-lighting must still be shown to destroy the separation, or this test has stopped meaning anything");
});

test("the underside floor lift is a fraction of the sky, and only below the horizon", () => {
  // The single line that made the movement a white blob. It lifts the floor
  // toward the sky as the camera goes under, and at 0.45 it took the dark
  // studio's floor from 0.055 to 0.297 — which the floor-bounce term then
  // multiplied again. Measured over the window: 0.846 / 0.062 at 0.45 against
  // 0.627 / 0.158 at 0.06.
  const m = RENDER_SRC.match(/sc\.ground\.map\(\(c, i\) => c \+ \(sc\.sky\[i\] - c\) \* ([\d.]+) \* under\)/);
  assert.ok(m, "the floor-lift line has moved; re-measure before changing its shape");
  assert.ok(Number(m[1]) <= 0.12, `the lift is back up to ${m[1]}: the underside will be on the shoulder again`);
  // ABOVE the horizon nothing may move: `under` is exactly 0 there, which is
  // what makes this a below-horizon-only change and leaves the standard shot
  // byte-identical. docs/WATCH-BUILDER.md §3.1 requires `dip` to be exactly 1
  // above the horizon; this is the other half of the same guarantee.
  assert.match(RENDER_SRC, /const dip = pitch >= 0 \? 1 : Math\.tanh\(pitch \* 2\.2\);/);
  assert.match(RENDER_SRC, /const under = Math\.max\(0, -dip\);/);
  const dip = (pitch) => (pitch >= 0 ? 1 : Math.tanh(pitch * 2.2));
  const under = (pitch) => Math.max(0, -dip(pitch));
  for (const pitch of [0, 0.05, 0.72, 1.44]) assert.equal(under(pitch), 0, `pitch ${pitch}`);
  assert.ok(under(-1.12) > 0.9, "the case-back view must still get the lift it is left");
});

// ---------------------------------------------------------------------------
// 2. The band is what the geometry core built, not what the slot says.

const STEEL_HINT = { kind: "steel", color: "#9aa2ab", rough: 0.4, metal: 1, brush: true, useCaseFinish: true };
const LEATHER_HINT = { kind: "leather", color: "#4a3226", rough: 0.92, metal: 0, brush: false, useCaseFinish: false };
const LEATHER_STRAP = { kind: "leather", id: "leather", color: "#4a3226" };

test("an integrated bracelet stays steel however the strap slot is set", () => {
  // The reported bug, verbatim: pick leather on a Royal Oak or a PRX and the
  // machined bracelet turned brown. `strapAssembly` returns
  // `integratedBraceletAssembly`'s mesh on those cases whatever the slot
  // holds, and says so in `strapMaterials.strap.kind === "steel"`.
  assert.equal(bandMaterialId(STEEL_HINT, LEATHER_STRAP, "steel-brushed"), "bracelet-brushed");
  assert.equal(bandMaterialId(STEEL_HINT, LEATHER_STRAP, "steel-polished"), "bracelet-polished");
  for (const kind of ["leather", "suede", "rubber", "nato", "nylon"]) {
    const id = bandMaterialId(STEEL_HINT, { kind, id: kind }, "steel-brushed");
    assert.ok(id.indexOf("bracelet-") === 0, `${kind} turned the bracelet into ${id}`);
    assert.equal(MATERIALS[id].metal, 1, `${kind} made the bracelet a dielectric`);
  }
  // And it takes the CASE's colour, not the strap's: same billet, same alloy.
  assert.equal(bandTakesCaseFinish(STEEL_HINT, LEATHER_STRAP), true);
});

test("a real strap still gets its FINER grade from the catalogue", () => {
  // The hint wins on the family and the slot wins inside it — the core says
  // "leather" where the catalogue says "shell cordovan", and the catalogue is
  // the better answer when the two agree.
  assert.equal(bandMaterialId(LEATHER_HINT, { kind: "leather", leather: "suede" }), "leather-suede");
  assert.equal(bandMaterialId(LEATHER_HINT, { kind: "leather", leather: "shell" }), "leather-shell");
  assert.equal(bandMaterialId(LEATHER_HINT, { kind: "leather", leather: "croc" }), "leather-croc");
  assert.equal(bandTakesCaseFinish(LEATHER_HINT, { kind: "leather" }), false);
  const nylon = { kind: "nylon", color: "#2b3038", rough: 0.88, metal: 0, brush: false, useCaseFinish: false };
  assert.equal(bandMaterialId(nylon, { kind: "nato" }), "nylon");
  assert.equal(bandMaterialId(nylon, { kind: "nato", weave: "seatbelt" }), "nylon-seatbelt");
  const rubber = { kind: "rubber", color: "#15171b", rough: 0.78, metal: 0, brush: false, useCaseFinish: false };
  assert.equal(bandMaterialId(rubber, { kind: "rubber" }), "rubber");
});

test("no hint at all falls back to exactly the old rule", () => {
  // An older core, or a build with no strap. The pre-hint behaviour is the
  // fallback rather than a throw, so a mesh never renders as nothing.
  assert.equal(bandMaterialId(null, { kind: "bracelet", id: "oyster" }, "steel-brushed"), "bracelet-brushed");
  assert.equal(bandMaterialId(null, { kind: "bracelet", id: "oyster" }, "steel-polished"), "bracelet-polished");
  assert.equal(bandMaterialId(null, { kind: "bracelet", id: "mesh" }, "steel-brushed"), "bracelet-polished");
  assert.equal(bandMaterialId(null, { kind: "leather", leather: "suede" }), "leather-suede");
  assert.equal(bandMaterialId(undefined, null), "leather");
  assert.equal(bandTakesCaseFinish(null, { kind: "bracelet" }), true);
  assert.equal(bandTakesCaseFinish(null, { kind: "leather" }), false);
  // Every id it can return has to exist, or materialFor silently substitutes
  // brushed steel and a leather strap comes out metal.
  for (const hint of [STEEL_HINT, LEATHER_HINT, null]) {
    for (const kind of ["leather", "rubber", "nato", "bracelet", "canvas", ""]) {
      const id = bandMaterialId(hint, { kind, id: kind }, "steel-brushed");
      assert.ok(MATERIALS[id], `${kind}/${hint && hint.kind} → unknown material ${id}`);
    }
  }
});

test("the renderer reads the hint rather than the slot", () => {
  // The seam itself, asserted in source: watch-render.js needs a GL context to
  // import, so this is the only place the wiring can be pinned outside a
  // browser. If the shape changes, change it here too — do not delete it.
  assert.match(RENDER_SRC, /assembled\.strapMaterials && assembled\.strapMaterials\.strap/);
  assert.match(RENDER_SRC, /bandMaterialId\(bandHint, parts\.strap, finishId\)/);
  assert.match(RENDER_SRC, /bandTakesCaseFinish\(bandHint, parts\.strap\)/);
  // The old rule must be gone, not merely shadowed.
  assert.doesNotMatch(RENDER_SRC, /parts\.strap\.kind === "bracelet" && finishId === "steel-polished"/);
});

test("strap HARDWARE is still steel, whatever the band is", () => {
  // PR #361's cousin of the same bug: `strapHardware` fell through
  // `meshMaterialId`'s /strap|band/ rule and a fold-over clasp rendered as
  // near-black leather, right behind the case back. The core's hint map fixes
  // it; this pins that the map is still consulted first.
  assert.equal(meshMaterialId("strapHardware", { strapHardware: "steel-brushed" }), "steel-brushed");
  assert.equal(materialFor(meshMaterialId("strapHardware", { strapHardware: "steel-brushed" })).metal, 1);
});
