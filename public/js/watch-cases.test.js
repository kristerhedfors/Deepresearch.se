// The CASE SHAPES of the NHxx watch builder (feedback #59, Vidar).
//
// Two asks, and this file guards both:
//
//   "Add a royal oak and PRX style case with integrated bracelet."
//   "Case designs are significantly improved from before but still often not
//    bearing significant resemblance to the real thing. The most important and
//    common case designs are explorer 2 style, submariner, prx, royal oak, and
//    alpinist."
//
// Everything here is about SHAPE — the plan outline, the vertical archetype,
// the integrated-bracelet construction, and the sourcing discipline the
// catalogue holds itself to. The catalogue-wide invariants (bilingual text,
// plausible millimetres, well-formed meshes over every case × every strap)
// already live in watch-core.test.js and are not repeated; what is here is
// what would let a "resemblance" fix quietly evaporate — a shell id that falls
// back to `diver` because of a typo, an outline that eats the dial, a bracelet
// that reads as a strap, or a mesh built inside out.
//
// THE INSIDE-OUT TRAP (PR #361). `extrude` and `lathe` want one winding, and a
// mesh built the other way round looks almost identical and relights wrong —
// which is invisible in a screenshot until the light moves. So the winding is
// checked NUMERICALLY here, two ways: the signed volume of every closed solid
// must be positive, and the face normal from each triangle's winding must
// agree with the vertex normals stored on it.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  CASES,
  SOURCES,
  PLATFORMS,
  SHELL_ARCHETYPES,
  DEFAULT_BUILD,
  DIAL_DIA,
  STRAPS,
  outlineFor,
  outlineSlopeFor,
  caseProfile,
  buildMeshes,
  checkBuild,
  strapAssembly,
  integratedBraceletOf,
  integratedPlan,
  integratedBraceletAssembly,
  caseKit,
  CRYSTALS,
} from "./watch-core.js";

/** The five shapes feedback #59 named as the ones that matter. */
const NAMED_BY_THE_REPORT = ["explorer-2", "sub", "prx", "royal-oak", "alpinist"];
/** The two that had to be built from nothing. */
const NEW_CASES = ["royal-oak", "prx", "explorer-2"];

const caseById = (/** @type {string} */ id) => {
  const c = CASES.find((x) => x.id === id);
  assert.ok(c, `no case ${id} in the catalogue`);
  return /** @type {any} */ (c);
};

/** @param {{positions:number[],indices:number[]}} m */
function signedVolume(m) {
  const p = m.positions;
  let v = 0;
  for (let i = 0; i < m.indices.length; i += 3) {
    const a = m.indices[i] * 3;
    const b = m.indices[i + 1] * 3;
    const c = m.indices[i + 2] * 3;
    v +=
      (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
        p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
        p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) /
      6;
  }
  return v;
}

/**
 * The fraction of triangles whose winding-derived normal agrees with the
 * vertex normals written on them. An inside-out mesh scores ~0 and looks fine
 * in a still.
 * @param {{positions:number[],normals:number[],indices:number[]}} m
 */
function normalAgreement(m) {
  const p = m.positions;
  const n = m.normals;
  let good = 0;
  let total = 0;
  for (let i = 0; i < m.indices.length; i += 3) {
    const a = m.indices[i] * 3;
    const b = m.indices[i + 1] * 3;
    const c = m.indices[i + 2] * 3;
    const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
    const e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
    const fn = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    const len = Math.hypot(fn[0], fn[1], fn[2]);
    if (len < 1e-12) continue;
    const vn = [
      (n[a] + n[b] + n[c]) / 3,
      (n[a + 1] + n[b + 1] + n[c + 1]) / 3,
      (n[a + 2] + n[b + 2] + n[c + 2]) / 3,
    ];
    total++;
    if ((fn[0] * vn[0] + fn[1] * vn[1] + fn[2] * vn[2]) / len > 0) good++;
  }
  return total ? good / total : 1;
}

/** @param {{positions:number[]}} m */
const verts = (m) => {
  /** @type {[number,number,number][]} */
  const out = [];
  for (let i = 0; i < m.positions.length; i += 3) {
    out.push([m.positions[i], m.positions[i + 1], m.positions[i + 2]]);
  }
  return out;
};

// ---------------------------------------------------------------------------

describe("the case shapes feedback #59 named", () => {
  test("all five exist, and the two new families are integrated-bracelet cases", () => {
    for (const id of NAMED_BY_THE_REPORT) {
      const c = caseById(id);
      assert.ok(c.name.en && c.name.sv, `${id} is not bilingual`);
    }
    assert.ok(integratedBraceletOf(caseById("royal-oak")), "the Royal Oak must be integrated");
    assert.ok(integratedBraceletOf(caseById("prx")), "the PRX must be integrated");
    // ...and nothing else is, so a stray flag cannot silently delete a case's
    // lugs.
    const integrated = CASES.filter((c) => integratedBraceletOf(c)).map((c) => c.id);
    assert.deepEqual(integrated.sort(), ["prx", "royal-oak"]);
  });

  test("every new dimension names a source that resolves, and is flagged approx", () => {
    // Docs §2: a listing is not a spec sheet. Every one of these came off a
    // retail page, so every one of them carries the ≈.
    for (const id of NEW_CASES) {
      const c = caseById(id);
      assert.ok(SOURCES[c.src], `${id} names unknown source ${c.src}`);
      assert.ok(SOURCES[c.src].url, `${id}'s source has no URL to check it against`);
      assert.equal(c.dims.approx, true, `${id}'s dimensions are off a listing and must say so`);
      assert.ok(c.note && c.note.en && c.note.sv, `${id} must record what its sources disagree about`);
      assert.notEqual(c.note.en, c.note.sv, `${id}'s note is untranslated`);
    }
    // The two whose figures were re-sourced rather than invented.
    assert.equal(caseById("alpinist").src, "namokiAlpine");
    assert.ok(caseById("sub").note, "the Sub's lug-width change must be recorded");
  });

  test("every case's shell resolves to a real archetype", () => {
    // The failure this exists for: `SHELL_ARCHETYPES[shell] || diver` means a
    // typo in a case's `shell` is not an error, it is the SKX's flank wearing
    // another name — which is exactly the complaint being answered.
    for (const c of CASES) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(SHELL_ARCHETYPES, c.shell),
        `${c.id} names shell "${c.shell}", which is not in SHELL_ARCHETYPES and would silently fall back to the diver`,
      );
    }
  });

  test("the five named shapes do not share a flank with the SKX", () => {
    // "Still often not bearing significant resemblance to the real thing" was
    // largely this: a Submariner, an Alpinist and an SKX drew the same flank.
    const sig = (/** @type {string} */ id) =>
      SHELL_ARCHETYPES[id]
        .flank(10, 10, { slim: 0.5, beefy: 0.5, reach: 0.5 })
        .map((p) => `${p.r.toFixed(3)}@${p.y.toFixed(3)}${p.s ? "s" : ""}`)
        .join(" ");
    const diver = sig("diver");
    for (const shell of ["sub", "tool", "alpinist", "octagon", "barrel"]) {
      assert.ok(SHELL_ARCHETYPES[shell], `${shell} archetype missing`);
      assert.notEqual(sig(shell), diver, `${shell} draws the diver's flank`);
    }
    assert.notEqual(sig("alpinist"), sig("dress"), "the Alpinist is not a dress case");
    assert.notEqual(sig("tool"), sig("dress"), "an Explorer II is not an Explorer I");
    assert.notEqual(sig("octagon"), sig("barrel"), "the Royal Oak and the PRX are different cases");
  });
});

// ---------------------------------------------------------------------------

describe("the octagon and the barrel in plan", () => {
  test("the octagon has eight straight edges, flats on the axes", () => {
    const k = outlineFor("octagon");
    // A flat at 3, 6, 9 and 12 — the bracelet leaves through 12 and 6, and the
    // crown sits on the 3 flat. A corner there is the bug this pins.
    for (const t of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
      assert.ok(Math.abs(k(t) - 1) < 1e-9, `θ=${t} should be the middle of a flat, got ${k(t)}`);
    }
    // Corners on the diagonals, standing 1/cos(π/8) out and no further.
    const corner = 1 / Math.cos(Math.PI / 8);
    for (let i = 0; i < 8; i++) {
      const t = Math.PI / 8 + (i * Math.PI) / 4;
      assert.ok(Math.abs(k(t) - corner) < 1e-9, `θ=${t} should be a corner`);
    }
    // The edges really are STRAIGHT: on one face, r·cos(θ − face) is constant.
    for (let i = -5; i <= 5; i++) {
      const t = (i / 5) * (Math.PI / 8) * 0.999;
      assert.ok(Math.abs(k(t) * Math.cos(t) - 1) < 1e-9, `the face through θ=0 bulges at ${t}`);
    }
  });

  test("neither new outline ever dips below 1", () => {
    // `lathe` modulates EVERY profile point, the bore included. An outline
    // under 1 pulls the case's inner wall in over the dial and crops its edge
    // at the flats — invisible in the maths, obvious the moment it is rendered.
    for (const shell of ["octagon", "barrel"]) {
      const k = outlineFor(shell);
      let min = Infinity;
      let max = -Infinity;
      for (let t = 0; t < Math.PI * 2; t += 0.001) {
        const v = k(t);
        assert.ok(Number.isFinite(v), `${shell} is not finite at ${t}`);
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
      assert.ok(min >= 1 - 1e-9, `${shell} dips to ${min}`);
      assert.ok(max < 1.2, `${shell} bulges to ${max}`);
    }
  });

  test("the modulated bore still clears the dial on every case", () => {
    // The general form of the check above, run over the real numbers: the
    // narrowest point of the case's inner wall has to stay outside the dial.
    for (const c of CASES) {
      const geo = caseProfile(c, CRYSTALS[0]);
      const k = outlineFor(c.shell);
      let min = Infinity;
      for (let t = 0; t < Math.PI * 2; t += 0.01) min = Math.min(min, k(t));
      const plat = PLATFORMS[c.platform];
      assert.ok(
        geo.boreR * min >= plat.dialDia / 2,
        `${c.id}: the bore closes to ${(geo.boreR * min).toFixed(2)} mm over a ${plat.dialDia / 2} mm dial`,
      );
    }
  });

  test("the slope of every outline is finite and matches a difference quotient", () => {
    for (const shell of Object.keys(SHELL_ARCHETYPES)) {
      const slope = outlineSlopeFor(shell);
      const k = outlineFor(shell);
      for (let t = 0.017; t < Math.PI * 2; t += 0.137) {
        const s = slope(t);
        assert.ok(Number.isFinite(s), `${shell} slope is not finite at ${t}`);
        const fd = (k(t + 1e-3) - k(t - 1e-3)) / 2e-3;
        assert.ok(Math.abs(s - fd) < 0.05, `${shell} slope ${s} vs ${fd} at ${t}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------

describe("the integrated bracelet", () => {
  test("the plan carries the published figures and marks the derived ones", () => {
    // namokiMODS publishes the PRX case's bracelet as tapering 24 → 18 mm;
    // nobody publishes the octagon's, so it is derived and the case's note
    // says so. The distinction is the whole of docs §2 in one field.
    const prx = integratedPlan(caseById("prx"));
    assert.equal(prx.width, 24);
    assert.equal(prx.endW, 18);
    const ro = integratedPlan(caseById("royal-oak"));
    assert.equal(caseById("royal-oak").integrated.widthMm, null, "the octagon's width is not published");
    assert.ok(ro.width > 0 && ro.width < caseById("royal-oak").dims.dia, "the derived width is implausible");
    assert.match(caseById("royal-oak").note.en, /not a measurement|render's own assumption|convention/i);
    for (const id of ["royal-oak", "prx"]) {
      const p = integratedPlan(caseById(id));
      assert.equal(p.approx, true);
      assert.ok(SOURCES[p.src], `${id} plan names unknown source ${p.src}`);
      assert.ok(p.note.en && p.note.sv && p.note.en !== p.note.sv, `${id} plan note is not bilingual`);
      for (const key of ["wall", "width", "endW", "thick", "endLen", "caseH", "pitch"]) {
        assert.ok(Number.isFinite(p[key]) && p[key] > 0, `${id}.${key} = ${p[key]}`);
      }
      assert.ok(p.endW < p.width, `${id} does not taper`);
      assert.ok(p.caseH > p.thick, `${id}: the end piece must be deeper than the links it becomes`);
    }
    assert.equal(integratedPlan(caseById("skx007")), null, "a lugged case has no integrated plan");
    assert.equal(integratedBraceletAssembly(caseById("skx007"), {}), null);
  });

  test("an integrated case has no lugs and no gap where the bracelet leaves it", () => {
    for (const id of ["royal-oak", "prx"]) {
      const c = caseById(id);
      const r = buildMeshes({ ...DEFAULT_BUILD, case: id }, { segments: 48 });
      assert.equal(r.meshes.lugs.indices.length, 0, `${id} must have no lugs — that is what integrated means`);
      const wall = (c.dims.dia / 2) * outlineFor(c.shell)(Math.PI / 2);
      const band = verts(r.meshes.strap);
      assert.ok(band.length > 0, `${id} has no bracelet`);
      // The nearest bracelet vertex on each side is INSIDE the case wall: the
      // end piece is tucked into the metal, so there is no daylight at the
      // join. This is the single thing that separates an integrated bracelet
      // from a strap that happens to be steel.
      for (const side of [1, -1]) {
        const arm = band.filter((p) => Math.sign(p[2]) === side);
        assert.ok(arm.length > 0, `${id}: no bracelet on the ${side > 0 ? "+z" : "-z"} side`);
        const nearest = Math.min(...arm.map((p) => Math.abs(p[2])));
        assert.ok(nearest < wall, `${id}: the bracelet starts ${nearest.toFixed(2)} mm out, past the ${wall.toFixed(2)} mm case wall`);
      }
      // ...and it still wraps the wrist on both sides.
      assert.ok(Math.max(...band.map((p) => p[2])) > wall, `${id}: the bracelet does not reach out`);
      assert.ok(Math.min(...band.map((p) => p[2])) < -wall, `${id}: the bracelet has only one arm`);
      // Nothing climbs the case.
      assert.ok(
        Math.max(...band.map((p) => p[1])) < c.dims.thick * 0.7,
        `${id}: the bracelet rises into the bezel`,
      );
    }
  });

  test("the bracelet is wide at the case, tapers, and is articulated", () => {
    for (const id of ["royal-oak", "prx"]) {
      const c = caseById(id);
      const plan = integratedPlan(c);
      const band = verts(buildMeshes({ ...DEFAULT_BUILD, case: id }, { segments: 96 }).meshes.strap);
      // Width where it leaves the case vs. width at the bottom of the wrist.
      const near = band.filter((p) => Math.abs(p[2]) > plan.wall * 0.9 && Math.abs(p[2]) < plan.wall * 1.3);
      const far = band.filter((p) => p[1] < -plan.wristR * 1.3);
      assert.ok(near.length && far.length, `${id}: cannot sample both ends`);
      const wNear = Math.max(...near.map((p) => Math.abs(p[0]))) * 2;
      const wFar = Math.max(...far.map((p) => Math.abs(p[0]))) * 2;
      assert.ok(Math.abs(wNear - plan.width) < 1.5, `${id}: ${wNear.toFixed(2)} mm at the case, planned ${plan.width}`);
      assert.ok(wFar < wNear - 1.5, `${id}: no taper — ${wNear.toFixed(2)} → ${wFar.toFixed(2)}`);
      // ARTICULATION. Rendered as one swept bar a bracelet is unreadable, so
      // the links have to be separate bodies across the band as well as along
      // it. Bucket the wrapped part by x: a solid band fills every bucket, a
      // five-across bracelet leaves grooves between its columns.
      const low = band.filter((p) => p[1] < -plan.wristR - 20);
      assert.ok(low.length > 200, `${id}: too few samples on the wrapped part`);
      const bins = new Array(40).fill(0);
      const halfSpan = plan.width / 2 + 1;
      for (const p of low) {
        const b = Math.floor(((p[0] + halfSpan) / (2 * halfSpan)) * 40);
        if (b >= 0 && b < 40) bins[b]++;
      }
      let clusters = 0;
      for (let i = 1; i < bins.length; i++) if (bins[i] > 0 && bins[i - 1] === 0) clusters++;
      assert.ok(
        clusters >= 4,
        `${id}: only ${clusters} bodies across the bracelet — it is drawing as a solid bar, not links`,
      );
    }
  });

  test("an integrated bracelet is steel and takes the case's own finish", () => {
    for (const id of ["royal-oak", "prx"]) {
      const kit = strapAssembly(caseById(id), STRAPS.find((s) => s.id === "leather"), { segments: 48 });
      // Even asked for leather: the case's bracelet is what exists.
      assert.equal(kit.materials.strap.kind, "steel");
      assert.equal(kit.materials.strap.useCaseFinish, true);
      assert.equal(kit.materials.strapHardware.kind, "steel");
      assert.ok(kit.hardware.indices.length > 0, `${id} has no clasp`);
      assert.ok(kit.plan.caseId === id);
    }
    // The wrist cylinder still obeys its switch.
    assert.equal(
      strapAssembly(caseById("prx"), STRAPS[0], { segments: 48, wrist: false }).wrist.indices.length,
      0,
    );
    assert.ok(strapAssembly(caseById("prx"), STRAPS[0], { segments: 48 }).wrist.indices.length > 0);
  });

  test("the strap slot says what it can and cannot do on an integrated case", () => {
    // "A case with an integrated bracelet should not silently accept a leather
    // strap." It does not: it warns, in both languages, naming the strap slot.
    const leather = checkBuild({ ...DEFAULT_BUILD, case: "royal-oak", strap: "leather" });
    const warn = leather.issues.find((i) => i.slot === "strap" && i.level === "warning");
    assert.ok(warn, "a leather strap on an integrated case must warn");
    assert.ok(warn.en && warn.sv && warn.en !== warn.sv, "the warning is not bilingual");
    assert.match(warn.en, /integrated|part of the case|no lugs/i);
    // ...but it is a warning, not an error: the watch is buildable.
    assert.equal(leather.ok, true);
    // A bracelet is a note rather than a warning — you have one either way.
    const bracelet = checkBuild({ ...DEFAULT_BUILD, case: "prx", strap: "oyster" });
    const note = bracelet.issues.find((i) => i.slot === "strap" && i.level === "note");
    assert.ok(note && note.en && note.sv && note.en !== note.sv);
    // And a lugged case says nothing of the kind.
    for (const i of checkBuild({ ...DEFAULT_BUILD, case: "skx007", strap: "leather" }).issues) {
      assert.ok(!/integrated/i.test(i.en), "the SKX must not claim an integrated bracelet");
    }
    // The kit table agrees: the bracelet comes with the case.
    for (const id of ["royal-oak", "prx"]) {
      assert.ok(caseKit(id).includes.includes("strap"), `${id}'s kit must include the bracelet`);
    }
  });
});

// ---------------------------------------------------------------------------

describe("winding — the inside-out trap PR #361 recorded", () => {
  test("every solid encloses a positive volume, on every case", () => {
    // A mesh built the other way round looks nearly identical and relights
    // wrong. Sign, not magnitude, is the assertion.
    for (const c of CASES) {
      const r = buildMeshes({ ...DEFAULT_BUILD, case: c.id }, { segments: 48 });
      for (const key of ["case", "crown", "caseback", "movement", "strap", "wrist"]) {
        const m = r.meshes[key];
        if (!m || !m.indices.length) continue;
        assert.ok(signedVolume(m) > 0, `${c.id}/${key} is inside out (volume ${signedVolume(m).toFixed(1)})`);
      }
      if (r.meshes.lugs.indices.length) {
        assert.ok(signedVolume(r.meshes.lugs) > 0, `${c.id}/lugs is inside out`);
      }
    }
  });

  test("stored normals agree with the winding on every new shape", () => {
    // The volume check catches a flipped winding; this catches the other half
    // of the same bug — a correct winding with the normals pointing in.
    for (const id of [...NEW_CASES, "sub", "alpinist", "skx007"]) {
      const r = buildMeshes({ ...DEFAULT_BUILD, case: id }, { segments: 48 });
      for (const key of ["case", "crown", "caseback", "strap"]) {
        const m = r.meshes[key];
        if (!m || !m.indices.length) continue;
        const agree = normalAgreement(m);
        assert.ok(agree > 0.98, `${id}/${key}: only ${(agree * 100).toFixed(1)}% of faces agree with their normals`);
      }
    }
  });

  test("the case profile of every new shape stays inside its catalogue millimetres", () => {
    for (const id of [...NEW_CASES, "sub", "sub-slim", "alpinist"]) {
      const c = caseById(id);
      const geo = caseProfile(c, CRYSTALS[0]);
      const ys = geo.profile.map((p) => p.y);
      const rs = geo.profile.map((p) => p.r);
      assert.ok(Math.min(...ys) >= 0, `${id} dips below the case back`);
      assert.ok(Math.max(...ys) <= c.dims.thick + 1e-9, `${id} is taller than the catalogue says`);
      assert.ok(Math.max(...rs) <= c.dims.dia / 2 + 1e-9, `${id} is wider than the catalogue says`);
      assert.ok(geo.crystalR > DIAL_DIA / 2 - 1, `${id}: the crystal is smaller than the dial`);
      assert.ok(geo.dialY > 0 && geo.dialY < geo.bezelTopY, `${id}: the dial is not under the crystal`);
    }
  });
});
