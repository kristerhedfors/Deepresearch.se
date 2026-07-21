// The strolling ghost's PURE core (public/cure/ghostwalk.js): the stroll
// planner, the facing math and the quip cycle. The DOM overlay (fixed,
// pointer-events:none, requestAnimationFrame legs) is browser-only and stays
// live-verified, per the project convention.
import test from "node:test";
import assert from "node:assert/strict";

import {
  GHOST_QUIPS,
  pickQuip,
  clickMessage,
  facing,
  planStroll,
  STROLL_SPEED,
  LEG_MS_MIN,
  LEG_MS_MAX,
} from "../cure/ghostwalk.js";

test("quips are non-empty short strings", () => {
  assert.ok(GHOST_QUIPS.length >= 3);
  for (const q of GHOST_QUIPS) {
    assert.equal(typeof q, "string");
    assert.ok(q.length > 0 && q.length <= 60, `quip length: ${q}`);
  }
});

test("pickQuip cycles and tolerates any integer index", () => {
  const n = GHOST_QUIPS.length;
  assert.equal(pickQuip(GHOST_QUIPS, 0), GHOST_QUIPS[0]);
  assert.equal(pickQuip(GHOST_QUIPS, n), GHOST_QUIPS[0], "wraps at length");
  assert.equal(pickQuip(GHOST_QUIPS, n + 2), GHOST_QUIPS[2]);
  assert.equal(pickQuip(GHOST_QUIPS, -1), GHOST_QUIPS[n - 1], "negatives wrap");
  assert.equal(pickQuip(GHOST_QUIPS, 5.9), GHOST_QUIPS[5 % n], "truncates");
  assert.equal(pickQuip([], 3), "", "empty is safe");
});

test("clickMessage pages through the queue in order, then signals retire", () => {
  const n = GHOST_QUIPS.length;
  // Tap 1 → first message, tap 2 → second, … tap n → last message.
  for (let c = 1; c <= n; c++) {
    assert.equal(clickMessage(GHOST_QUIPS, c), GHOST_QUIPS[c - 1], `tap ${c}`);
  }
  // The tap AFTER the last message returns null → the DOM layer retires.
  assert.equal(clickMessage(GHOST_QUIPS, n + 1), null, "exhausted → retire");
  assert.equal(clickMessage(GHOST_QUIPS, n + 5), null, "stays exhausted");
});

test("clickMessage does not wrap and is safe at the edges", () => {
  assert.equal(clickMessage(GHOST_QUIPS, 0), null, "no tap yet");
  assert.equal(clickMessage(GHOST_QUIPS, -3), null, "negatives are null");
  assert.equal(clickMessage(GHOST_QUIPS, 1.9), GHOST_QUIPS[0], "truncates to tap 1");
  assert.equal(clickMessage([], 1), null, "empty is safe");
});

test("facing is rightward by default, leftward only on a backward move", () => {
  assert.equal(facing(0, 100), 1);
  assert.equal(facing(100, 0), -1);
  assert.equal(facing(50, 50), 1, "zero-length keeps the rightward default");
});

test("planStroll keeps every target inside the usable band", () => {
  const vw = 900;
  const ghostW = 80;
  const margin = 16;
  const legs = planStroll({ vw, ghostW, legs: 8, margin, rand: () => 0.5 });
  assert.equal(legs.length, 8);
  for (const leg of legs) {
    assert.ok(leg.x >= margin - 1e-9, `x ${leg.x} >= ${margin}`);
    assert.ok(leg.x <= vw - ghostW - margin + 1e-9, `x ${leg.x} <= ${vw - ghostW - margin}`);
  }
});

test("planStroll makes every leg actually walk a real distance", () => {
  // A rand that keeps landing near the current spot must still be nudged out
  // by minTravel so the ghost never stands still.
  const vw = 900;
  const ghostW = 80;
  const minTravel = 120;
  const legs = planStroll({ vw, ghostW, legs: 10, minTravel, rand: () => 0.5 });
  let cur = -ghostW; // the planner's off-screen start
  for (const leg of legs) {
    assert.ok(Math.abs(leg.x - cur) >= minTravel - 1e-6, `travel ${Math.abs(leg.x - cur)}`);
    assert.ok(leg.face === 1 || leg.face === -1);
    cur = leg.x;
  }
});

test("planStroll durations scale with distance and stay clamped", () => {
  const legs = planStroll({ vw: 2000, ghostW: 80, legs: 6, rand: () => 0.5 });
  for (const leg of legs) {
    assert.ok(leg.dur >= LEG_MS_MIN, `dur ${leg.dur} >= ${LEG_MS_MIN}`);
    assert.ok(leg.dur <= LEG_MS_MAX, `dur ${leg.dur} <= ${LEG_MS_MAX}`);
  }
  assert.ok(STROLL_SPEED > 0);
});

test("planStroll: the walk-in (first leg) never speaks; later legs can", () => {
  const legs = planStroll({ vw: 900, ghostW: 80, legs: 6, rand: () => 0.1 });
  assert.equal(legs[0].say, false, "no bubble on the entrance leg");
  assert.equal(legs[0].quip, "");
  // With a low rand every eligible leg speaks; assert at least one does and
  // that a speaking leg carries a quip while a silent one does not.
  assert.ok(legs.slice(1).some((l) => l.say), "some later leg speaks");
  for (const leg of legs) {
    if (leg.say) assert.ok(leg.quip.length > 0);
    else assert.equal(leg.quip, "");
  }
});

test("planStroll is deterministic for a fixed rand sequence", () => {
  const seq = [0.2, 0.8, 0.4, 0.9, 0.1, 0.6, 0.35, 0.7];
  const mk = () => {
    let i = 0;
    return () => seq[i++ % seq.length];
  };
  const a = planStroll({ vw: 800, ghostW: 80, legs: 5, rand: mk() });
  const b = planStroll({ vw: 800, ghostW: 80, legs: 5, rand: mk() });
  assert.deepEqual(a, b);
});

test("planStroll survives a viewport too narrow to offer any span", () => {
  // hi clamps up to lo; every target collapses onto the margin but the call
  // still returns valid, finite legs (no NaN, no inverted range).
  const legs = planStroll({ vw: 100, ghostW: 80, legs: 4, margin: 40, rand: () => 0.9 });
  assert.equal(legs.length, 4);
  for (const leg of legs) {
    assert.ok(Number.isFinite(leg.x));
    assert.ok(Number.isFinite(leg.dur) && leg.dur > 0);
  }
});
