// The strap, the cushion, the buckle and the clasps — feedback #59's slice of
// the NHxx watch builder.
//
// The four complaints this suite exists for, verbatim from the report:
//
//   1. "strap/bracelet sits weirdly with a bend near the lugs which has no
//      reason to be there"
//   2. "The leather cushion the watch sits on is perfectly round, it should
//      account for the squish it would receive from the watch."
//   3. "Make the leather cushion just wide enough for the watch to sit on it,
//      not so wide as to replicate a forearm."
//   4. "Buckle can be improved. Also add butterfly clasp to models that have
//      it."
//
// What a Node test can and cannot reach here is worth being honest about. It
// can measure the PATH — how fast the band turns per millimetre of its own
// length is a number, and the bend in (1) was a 6.4°/mm spike four
// millimetres off the lug tip. It can measure the print, the cushion's length
// against the case's, and that each clasp is a different object. It cannot
// tell you whether any of it LOOKS right; that was verified in a browser
// against a local Worker (the live-verify skill), which is where every
// rendering bug in this subsystem has actually been found.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  CASES,
  STRAPS,
  BUCKLES,
  BRACELET_TYPES,
  SOURCES,
  WRIST_HOLDER,
  STRAP_EXIT,
  STRAP_DRAPE,
  BUCKLE_STOCK,
  CLASP_STYLES,
  resolveClasp,
  strapPlan,
  strapPath,
  lugAnchor,
  buckleMesh,
  wristMesh,
  cushionLength,
  cushionPenetration,
  caseFootprint,
  strapAssembly,
} from "./watch-core.js";

const SKX = CASES[0];

/** Positive means wound outward, which is what back-face culling needs. */
function signedVolume(m) {
  let v = 0;
  for (let i = 0; i < m.indices.length; i += 3) {
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

/**
 * How fast the path turns, in degrees per millimetre of arc length, sampled
 * over the LEAD-IN — from the lug to wherever the wrap begins. That is where
 * the reported bend was, and everything past it is the cushion's own constant
 * curvature.
 */
function leadInTurn(path, dir, upTo) {
  let worst = 0;
  let worstAt = 0;
  let prev = null;
  for (const f of path.frames) {
    if (f.s > upTo) break;
    const ang = (Math.atan2(f.ty, dir * f.tz) * 180) / Math.PI;
    if (prev) {
      const ds = f.s - prev.s;
      if (ds > 1e-9) {
        const rate = (ang - prev.ang) / ds;
        if (Math.abs(rate) > Math.abs(worst)) {
          worst = rate;
          worstAt = f.s;
        }
      }
    }
    prev = { s: f.s, ang };
  }
  return { worst, worstAt };
}

// ---------------------------------------------------------------------------

describe("the lug exit has no bend in it (feedback #59)", () => {
  test("the band leaves the lug at the steep angle the taut span really runs at", () => {
    // THE ROOT CAUSE, pinned. STRAP_EXIT.degrees answers "at what angle around
    // the wrist does the strap first touch it"; the renderer also used it as
    // "at what angle below horizontal does the band leave the lug". They are
    // different quantities — 29.5° against 67–76° — and the lead-in curve had
    // to absorb the difference. The exit is DERIVED now, so what it must equal
    // is the direction of the run it is starting, within the exit ease.
    for (const c of CASES) {
      for (const s of STRAPS) {
        const plan = strapPlan(c, s);
        if (plan.build === "nato") continue; // its own bridge geometry
        for (const dir of [1, -1]) {
          const p = strapPath(c, plan, dir, 0);
          const f0 = p.frames[0];
          const exit = Math.atan2(f0.ty, dir * f0.tz);
          const mid = p.at(Math.min(p.total * 0.2, 10));
          const span = Math.atan2(mid.ty, dir * mid.tz);
          const easeMax = (STRAP_EXIT.easeDegrees * Math.PI) / 180 + 1e-6;
          assert.ok(
            exit - span >= -1e-6 && exit - span <= easeMax,
            `${c.id}/${s.id} arm ${dir}: exits ${exit} against a span of ${span}`,
          );
          // And it is nowhere near the angle the bug used: down and outward.
          assert.ok(exit < -0.9 && exit > -1.5, `${c.id}/${s.id} arm ${dir} exits at ${exit} rad`);
        }
      }
    }
  });

  test("the lead-in does not bend at all — it is the taut span", () => {
    // The measurement that named the bug: before the fix the SKX/leather arm
    // spiked at 6.4°/mm 4.35 mm from the lug tip and then UN-bent, two
    // inflections before the wrap started. A taut strap pivoting on a spring
    // bar is a straight line, so the honest number to hold it to is zero.
    for (const c of CASES) {
      for (const s of STRAPS) {
        const plan = strapPlan(c, s);
        if (plan.build === "nato") continue;
        for (const dir of [1, -1]) {
          const p = strapPath(c, plan, dir, 0);
          // Stop short of the tangent point: the wrap's own curvature is real
          // and starts there, and the central difference smears it one sample
          // back. `total * 0.2` is inside the straight run on every case here.
          const { worst, worstAt } = leadInTurn(p, dir, p.total * 0.2);
          assert.ok(
            Math.abs(worst) < 0.05,
            `${c.id}/${s.id} arm ${dir} turns ${worst.toFixed(3)}°/mm at s=${worstAt.toFixed(2)}`,
          );
        }
      }
    }
  });

  test("the whole arm turns ONE way — no S bend anywhere", () => {
    // The other half of the artifact: the old Hermite over-plunged past the
    // taut line and came back, so the sign of the turn flipped twice before
    // the band reached the cushion. From the lug to the clasp the band should
    // bend one way only, so the net turn and the total turn must agree.
    for (const s of STRAPS) {
      const plan = strapPlan(SKX, s);
      if (plan.build === "nato") continue;
      for (const dir of [1, -1]) {
        const p = strapPath(SKX, plan, dir, 0);
        let net = 0;
        let abs = 0;
        let prev = null;
        for (const f of p.frames) {
          const ang = (Math.atan2(f.ty, dir * f.tz) * 180) / Math.PI;
          if (prev != null) {
            net += ang - prev;
            abs += Math.abs(ang - prev);
          }
          prev = ang;
        }
        assert.ok(abs - Math.abs(net) < 0.05, `${s.id} arm ${dir}: |net| ${Math.abs(net)} vs total ${abs}`);
      }
    }
  });

  test("the anchor is the lug's own drilled centre, not a rounder number", () => {
    // The seam that had drifted: buildMeshes tapers each lug tip from
    // thick * 0.09 to thick * 0.4, so the hole is at thick * 0.245. lugAnchor
    // said thick * 0.3 and started every band three quarters of a millimetre
    // high on its own spring bar.
    for (const c of CASES) {
      const a = lugAnchor(c);
      assert.ok(Math.abs(a.y - (c.dims.thick * 0.4 + c.dims.thick * 0.09) / 2) < 1e-9, c.id);
      assert.ok(a.z >= c.dims.l2l / 2 - 1e-9, `${c.id} anchors inside its own lug-to-lug`);
    }
  });

  test("one radius, and it is the cushion's own sourced one", () => {
    // STRAP_DRAPE used to carry an independent 30 mm for the same object
    // WRIST_HOLDER measures at 27, so the drape was solved against a cushion
    // 3 mm fatter than the one drawn.
    assert.equal(STRAP_DRAPE.wristR, WRIST_HOLDER.radiusMm);
    assert.equal(strapPlan(SKX, STRAPS[0]).wristR, WRIST_HOLDER.radiusMm);
  });

  test("the exit ease is bounded, and both records say what they are", () => {
    // Zero, and STRAP_EXIT's note says why — a flatter exit and a tangential
    // arrival at the same tangent point are not simultaneously satisfiable.
    // Bounded rather than pinned at 0 so the mechanism can be revisited with
    // a moving tangent point without the test becoming a lie in the meantime.
    assert.ok(STRAP_EXIT.easeDegrees >= 0 && STRAP_EXIT.easeDegrees <= 15);
    assert.ok(STRAP_DRAPE.exitEaseSpan > 0 && STRAP_DRAPE.exitEaseSpan <= 1);
    assert.equal(STRAP_DRAPE.approx, true);
    assert.ok(SOURCES[STRAP_EXIT.src] && SOURCES[STRAP_DRAPE.src]);
    for (const k of ["en", "sv"]) {
      assert.ok(STRAP_EXIT.note[k].length > 80, `STRAP_EXIT note.${k}`);
      assert.ok(WRIST_HOLDER.note[k].length > 80, `WRIST_HOLDER note.${k}`);
    }
    assert.notEqual(STRAP_EXIT.note.en, STRAP_EXIT.note.sv);
    assert.notEqual(WRIST_HOLDER.note.en, WRIST_HOLDER.note.sv);
  });
});

// ---------------------------------------------------------------------------

describe("the cushion is a pillow, not a forearm (feedback #59)", () => {
  test("it is the case plus a margin, and nothing like a limb", () => {
    for (const c of CASES) {
      const len = cushionLength(c);
      assert.equal(len, c.dims.dia + 2 * WRIST_HOLDER.marginMm);
      // Wider than the watch, because the watch has to sit ON it...
      assert.ok(len > c.dims.dia, `${c.id} cushion is narrower than the case`);
      // ...but nowhere near the 93 mm the old `max(52, dia * 2.2)` gave a 42.5
      // mm case, which is what "replicate a forearm" was about.
      assert.ok(len < c.dims.dia * 1.5, `${c.id} cushion is ${len} mm for a ${c.dims.dia} mm case`);
      const b = bounds(wristMesh(c, STRAPS[0], { segments: 64 }));
      assert.ok(Math.abs(b.maxX - len / 2) < 1e-6, `${c.id} mesh is not ${len} mm long`);
      assert.ok(Math.abs(b.maxX + b.minX) < 1e-9, `${c.id} cushion is not centred on x = 0`);
    }
    assert.equal(WRIST_HOLDER.lengthApprox, true);
    assert.equal(WRIST_HOLDER.contactApprox, true);
  });

  test("the watch presses a real print into it", () => {
    // Not a smaller cylinder: a FLAT, at the plane the case back rests on, as
    // wide as the case and no wider.
    for (const c of CASES) {
      const plan = strapPlan(c, STRAPS.find((s) => s.id === "leather"));
      const pen = cushionPenetration(c, plan);
      // Dead under the case, the leather is pushed in by the full sink.
      assert.ok(
        Math.abs(pen(0, Math.PI / 2) - WRIST_HOLDER.sinkMm) < 1e-6,
        `${c.id}: centre penetration ${pen(0, Math.PI / 2)}`,
      );
      // Off the end of the case, it is untouched.
      assert.equal(pen(c.dims.dia, Math.PI / 2), 0, `${c.id}: leather beyond the case is dented`);
      // And nowhere near the bottom of the cushion, which the watch never sees.
      assert.equal(pen(0, -Math.PI / 2), 0, `${c.id}: the underside of the cushion is dented`);
    }
  });

  test("the print is the case's own outline, so a cushion case leaves a cushion", () => {
    // The Turtle is a superellipse in plan and the SKX is round. If the print
    // came from one radius, the two would leave the same mark.
    const round = caseFootprint(CASES.find((c) => c.shell === "diver"));
    const cushionCase = caseFootprint(CASES.find((c) => c.shell === "cushion"));
    const spread = (f) => {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < 64; i++) {
        const v = f((i / 64) * Math.PI * 2);
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      return hi / lo;
    };
    assert.ok(spread(round) < 1.001, "a round diver's print must be round");
    assert.ok(spread(cushionCase) > 1.05, "a cushion case's print must not be round");
  });

  test("the print is a flat at the case-back plane, with a ridge round it", () => {
    const m = wristMesh(SKX, STRAPS.find((s) => s.id === "leather"), { segments: 96 });
    const plan = strapPlan(SKX, STRAPS.find((s) => s.id === "leather"));
    const kit = strapAssembly(SKX, STRAPS.find((s) => s.id === "leather"), { segments: 96 });
    const crown = kit.wristInfo.cy + kit.wristInfo.r;
    const contact = crown - WRIST_HOLDER.sinkMm;
    // Walk the crown line (z ≈ 0) and collect the highest y at each x.
    const byX = new Map();
    for (let i = 0; i < m.positions.length; i += 3) {
      if (Math.abs(m.positions[i + 2]) > 1.5) continue;
      const x = +m.positions[i].toFixed(3);
      const y = m.positions[i + 1];
      if (!byX.has(x) || y > byX.get(x)) byX.set(x, y);
    }
    const xs = [...byX.keys()].sort((a, b) => a - b);
    const flat = xs.filter((x) => Math.abs(byX.get(x) - contact) < 1e-6);
    // A flat as long as the case is wide, give or take the soft edge.
    assert.ok(flat.length > 8, `the print is only ${flat.length} samples long`);
    const flatWidth = Math.max(...flat) - Math.min(...flat);
    assert.ok(flatWidth > SKX.dims.dia * 0.6, `the print is ${flatWidth} mm across a ${SKX.dims.dia} mm case`);
    assert.ok(flatWidth < SKX.dims.dia, "the print is wider than the case that made it");
    // And a ridge: somewhere outside the print the leather stands proud of the
    // undeformed crown, which is the displaced material coming back.
    const peak = Math.max(...xs.map((x) => byX.get(x)));
    assert.ok(peak > crown + 0.02, `no ridge: peak ${peak} against a crown of ${crown}`);
    assert.ok(peak < crown + WRIST_HOLDER.sinkMm * WRIST_HOLDER.bulge + 1e-6, `the ridge is too high at ${peak}`);
  });

  test("the deformed cushion is still a closed, outward-wound solid", () => {
    // PR #361's trap: an inside-out mesh looks nearly identical and relights
    // wrong, so the sign of the volume is checked numerically, not by eye.
    for (const c of CASES) {
      for (const s of STRAPS) {
        const m = wristMesh(c, s, { segments: 96 });
        assert.ok(signedVolume(m) > 0, `${c.id}/${s.id} cushion is wound inside out`);
        for (let i = 0; i < m.normals.length; i += 3) {
          const l = Math.hypot(m.normals[i], m.normals[i + 1], m.normals[i + 2]);
          assert.ok(Math.abs(l - 1) < 1e-6, `${c.id}/${s.id} normal ${i / 3} has length ${l}`);
        }
        for (const v of m.positions) assert.ok(Number.isFinite(v), `${c.id}/${s.id} has a NaN`);
        assert.ok(m.positions.length / 3 < 65536, `${c.id}/${s.id} needs 32-bit indices`);
      }
    }
  });

  test("the print never cuts through the leather or lifts the strap off it", () => {
    for (const s of STRAPS) {
      const kit = strapAssembly(SKX, s, { segments: 96 });
      const m = kit.wrist;
      const { r, cy } = kit.wristInfo;
      for (let i = 0; i < m.positions.length; i += 3) {
        const rad = Math.hypot(m.positions[i + 2], m.positions[i + 1] - cy);
        assert.ok(rad >= -1e-9, `${s.id} cushion has a negative radius`);
        assert.ok(rad <= r + WRIST_HOLDER.sinkMm + 1e-6, `${s.id} cushion bulges to ${rad}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------

describe("the buckle reads as hardware (feedback #59)", () => {
  test("it is one bent frame, a hinge pin and a tapered prong", () => {
    const m = buckleMesh(18, 3.5);
    assert.ok(signedVolume(m) > 0, "the buckle is wound inside out");
    for (let i = 0; i < m.normals.length; i += 3) {
      const l = Math.hypot(m.normals[i], m.normals[i + 1], m.normals[i + 2]);
      assert.ok(Math.abs(l - 1) < 1e-6, `normal ${i / 3} has length ${l}`);
    }
    for (const v of m.positions) assert.ok(Number.isFinite(v));
    const max = Math.max(...m.indices);
    assert.ok(max < m.positions.length / 3, "an index runs past the end of the buffer");
    // It used to be five axis-aligned boxes: 5 × 24 vertices. A bent frame
    // with a round section is a different order of thing.
    assert.ok(m.positions.length / 3 > 150, "the buckle is still a handful of boxes");
  });

  test("it is the width the strap has where it sits, still", () => {
    // Unchanged rule, restated because the frame was rebuilt around it: a
    // buckle drawn at lug width reads as wrong without anyone being able to
    // say why. The widest point is the frame's own side at the crossbar.
    for (const width of [16, 18, 20, 22]) {
      const b = bounds(buckleMesh(width, 3.5));
      const across = b.maxX - b.minX;
      assert.ok(
        Math.abs(across - (width + 0.9 + 2 * BUCKLE_STOCK.bar)) < 0.05,
        `a ${width} mm strap got a ${across} mm buckle`,
      );
    }
  });

  test("the prong lies over the opening and out of the frame's plane", () => {
    const b = bounds(buckleMesh(18, 3.5));
    // The prong is the only thing above the frame's mid-plane by more than the
    // stock, and it must not poke out the back of the opening.
    const stock = Math.max(BUCKLE_STOCK.plate, 3.5 * 0.55);
    assert.ok(b.maxY > stock * 0.5, `nothing stands proud of the frame: ${b.maxY}`);
    assert.ok(b.maxZ < BUCKLE_STOCK.open, "the frame is longer than its own opening plus stock");
  });

  test("the stock table names a source and admits what it is", () => {
    assert.ok(SOURCES[BUCKLE_STOCK.src]);
    assert.equal(BUCKLE_STOCK.approx, true);
    assert.ok(BUCKLE_STOCK.pin > 0 && BUCKLE_STOCK.prong > 0 && BUCKLE_STOCK.prong <= 1);
  });
});

// ---------------------------------------------------------------------------

describe("clasps, and the butterfly on a bracelet (feedback #59)", () => {
  test("a butterfly clasp is offered on bracelets", () => {
    const bf = BUCKLES.find((b) => b.id === "butterfly");
    assert.ok(bf.kinds.includes("bracelet"), "the feedback asked for exactly this");
    assert.ok(bf.kinds.includes("leather") && bf.kinds.includes("rubber"), "and it must not lose the strap kinds");
    assert.ok(bf.note && bf.note.en && bf.note.sv);
    assert.notEqual(bf.note.en, bf.note.sv);
  });

  test("every catalogue clasp builds, and no two build the same thing", () => {
    // The regression this pins is what feedback #59 found: every bracelet drew
    // the same two plates, so four named clasps were one object.
    const seen = new Map();
    for (const b of BUCKLES) {
      assert.ok(CLASP_STYLES[b.id], `${b.id} has no closure behaviour`);
      const kind = b.kinds.includes("bracelet") ? "oyster" : "leather";
      const strap = { ...STRAPS.find((s) => s.id === kind), buckle: b.id };
      const kit = strapAssembly(SKX, strap, { segments: 96 });
      assert.ok(kit.hardware.positions.length > 0, `${b.id} builds nothing`);
      assert.ok(signedVolume(kit.hardware) > 0, `${b.id} is wound inside out`);
      for (const v of kit.hardware.positions) assert.ok(Number.isFinite(v), `${b.id} has a NaN`);
      const sig = `${kit.hardware.positions.length}:${signedVolume(kit.hardware).toFixed(2)}`;
      const style = CLASP_STYLES[b.id].style;
      if (seen.has(sig)) {
        assert.equal(seen.get(sig), style, `${b.id} builds the same mesh as ${seen.get(sig)}`);
      }
      seen.set(sig, style);
    }
    // The two tang buckles genuinely share a frame; everything else is its own.
    assert.ok(seen.size >= 6, `only ${seen.size} distinct clasp meshes for ${BUCKLES.length} entries`);
  });

  test("a folding clasp has no free tail and no keepers", () => {
    // A butterfly clasp closes the strap on itself. The tail and the keepers
    // that hold it belong to a tang buckle and to nothing else.
    const tang = strapAssembly(SKX, { ...STRAPS.find((s) => s.id === "leather"), buckle: "tang" }, { segments: 96 });
    const bf = strapAssembly(SKX, { ...STRAPS.find((s) => s.id === "leather"), buckle: "butterfly" }, { segments: 96 });
    assert.equal(tang.plan.close, "buckle");
    assert.ok(tang.plan.keepers > 0);
    assert.equal(bf.plan.close, "clasp");
    assert.equal(bf.plan.keepers, 0);
    assert.ok(bf.band.positions.length < tang.band.positions.length, "the butterfly build still carries a tail");
  });

  test("a NATO keeps its buckle whatever the slot says", () => {
    // Nylon runs through a buckle; there is no folding clasp on a NATO, and a
    // slot choice must not invent one.
    const kit = strapAssembly(SKX, { ...STRAPS.find((s) => s.id === "nato"), buckle: "butterfly" }, { segments: 96 });
    assert.equal(kit.plan.close, "buckle");
    assert.equal(kit.plan.claspStyle, "tang");
  });

  test("the bracelet TYPE picks the clasp when nothing else does", () => {
    // Choosing a President on the Oyster used to keep the Oyster's flip-lock,
    // because the listing default and an explicit choice land in the same
    // field. The type's own clasp wins over the listing's default; an explicit
    // pick still wins over both.
    const oyster = STRAPS.find((s) => s.id === "oyster");
    const president = BRACELET_TYPES.find((b) => b.id === "president");
    assert.equal(resolveClasp(oyster), oyster.buckle);
    assert.equal(resolveClasp({ ...oyster, geometry: president }), president.clasp);
    assert.equal(resolveClasp({ ...oyster, geometry: president, buckle: "butterfly" }), "butterfly");
    // And an unknown or missing hardware id degrades rather than throwing.
    assert.equal(resolveClasp({ ...oyster, buckle: "no-such-clasp" }), oyster.buckle);
    assert.equal(resolveClasp(null), "tang");
    assert.equal(resolveClasp({ kind: "bracelet" }), "flip-lock");
  });

  test("the bracelet TYPE picks the construction too", () => {
    // Same drift, one layer down: strapPlan keyed on the strap's id, so every
    // braceletType drew the row the STRAPS entry named.
    const oyster = STRAPS.find((s) => s.id === "oyster");
    assert.equal(strapPlan(SKX, oyster).id, "oyster");
    assert.equal(strapPlan(SKX, { ...oyster, type: "beads-of-rice" }).cols.length, 7);
    assert.equal(strapPlan(SKX, { ...oyster, type: "jubilee" }).cols.length, 5);
    // Milanese has no row of its own under its type name and must fall back to
    // the strap id rather than to a link bracelet.
    const mesh = STRAPS.find((s) => s.id === "mesh");
    assert.equal(strapPlan(SKX, mesh).build, "woven");
  });

  test("every clasp still sits at the bottom of the cushion, not out at the lugs", () => {
    for (const b of BUCKLES) {
      const kind = b.kinds.includes("bracelet") ? "oyster" : "leather";
      const strap = { ...STRAPS.find((s) => s.id === kind), buckle: b.id };
      const kit = strapAssembly(SKX, strap, { segments: 96 });
      const hb = bounds(kit.hardware);
      assert.ok(hb.maxY < -kit.wristInfo.r * 0.5, `${b.id} hardware sits at y=${hb.maxY}`);
      assert.ok(hb.maxX - hb.minX < SKX.dims.lugW + 4, `${b.id} is wider than the band it closes`);
    }
  });
});
