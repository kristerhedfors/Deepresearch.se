// The DRC depth view's PURE core (public/cure/depth.js): the hardcoded
// eight-depth fragment tree of the trust-boundary reasoning and the
// zoom/reveal math. The gesture/DOM layer is browser-only and stays
// live-verified, per the project convention (like the umbrella intro).
import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_DEPTH,
  MIN_ZOOM,
  MAX_ZOOM,
  DEPTH_FRAGMENTS,
  flattenFragments,
  clampZoom,
  revealAt,
  wheelZoom,
  pinchZoom,
  gaugeFill,
} from "../cure/depth.js";

test("the tree is one thesis, eight depths deep, no deeper", () => {
  assert.equal(MAX_DEPTH, 8); // the 2026-07-12 directive: initially exactly 8
  assert.equal(DEPTH_FRAGMENTS.length, 1); // one root — the whole argument has one thesis
  const all = flattenFragments();
  const depths = all.map((f) => f.depth);
  assert.equal(Math.max(...depths), MAX_DEPTH); // at least one chain reaches the bottom
  assert.ok(depths.every((d) => d >= 1 && d <= MAX_DEPTH));
  // Every depth level 1..8 is populated — no hollow zoom stops.
  for (let d = 1; d <= MAX_DEPTH; d++) {
    assert.ok(depths.includes(d), `depth ${d} has fragments`);
  }
  // A real corpus, not a stub — and every fragment is a substantive summary.
  assert.ok(all.length >= 30, `got ${all.length} fragments`);
  const ids = all.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length, "fragment ids are unique");
  for (const f of all) {
    assert.ok(f.text.trim().length >= 60, f.id + " is a real fragment");
    assert.equal(f.text.includes("<"), false, f.id + " is plain text — no markup, no links");
  }
});

test("the content carries the trust-boundary argument, shallow to deep", () => {
  const all = flattenFragments();
  const atDepth = (d) => all.filter((f) => f.depth === d).map((f) => f.text).join(" ");
  // The thesis states the boundary and the three choices up front.
  assert.match(atDepth(1), /ONE external dataflow/);
  assert.match(atDepth(1), /OpenAI, Berget, or a local endpoint/);
  assert.match(atDepth(1), /verifiable code/);
  // Deep levels reach real mechanism: crypto sizes and reproduction steps.
  const deep = atDepth(7) + atDepth(8);
  assert.match(deep, /HKDF|sha256|node --test/i);
  // Not privacy superlatives — the framing is boundary isolation.
  assert.equal(/100% private|fully anonymous|untraceable/i.test(all.map((f) => f.text).join(" ")), false);
});

test("revealAt: thesis always open; depth d opens across zoom (d−1)…d", () => {
  for (const z of [1, 3.7, 8]) assert.equal(revealAt(1, z), 1);
  // Integer zoom k shows exactly depths 1..k in full, k+1.. not at all.
  for (let k = 1; k <= 8; k++) {
    for (let d = 2; d <= 8; d++) {
      const r = revealAt(d, k);
      if (d <= k) assert.equal(r, 1, `depth ${d} open at zoom ${k}`);
      else if (d > k + 1) assert.equal(r, 0, `depth ${d} absent at zoom ${k}`);
    }
  }
  // Mid-transition is strictly between — the compression is continuous…
  const mid = revealAt(4, 3.5);
  assert.ok(mid > 0 && mid < 1);
  // …and monotone in zoom at every depth.
  for (let d = 2; d <= 8; d++) {
    let prev = -1;
    for (let z = 1; z <= 8.001; z += 0.1) {
      const r = revealAt(d, z);
      assert.ok(r >= prev - 1e-12, `reveal fell at depth ${d}, zoom ${z}`);
      prev = r;
    }
  }
});

test("clampZoom pins to [1, 8] and swallows garbage", () => {
  assert.equal(MIN_ZOOM, 1);
  assert.equal(MAX_ZOOM, 8);
  assert.equal(clampZoom(0), 1);
  assert.equal(clampZoom(-5), 1);
  assert.equal(clampZoom(99), 8);
  assert.equal(clampZoom(4.2), 4.2);
  assert.equal(clampZoom(NaN), 1);
});

test("wheelZoom: scroll up expands, down compresses, clamped, mode-normalized", () => {
  assert.ok(wheelZoom(4, -100) > 4); // wheel up / pinch out → deeper
  assert.ok(wheelZoom(4, 100) < 4); // wheel down → compress
  assert.equal(wheelZoom(8, -10_000), 8);
  assert.equal(wheelZoom(1, 10_000), 1);
  // ~500 px of travel crosses one depth.
  assert.ok(Math.abs(wheelZoom(4, -500) - 5) < 0.01);
  // Line mode (Firefox wheels) is scaled to comparable travel.
  assert.ok(Math.abs(wheelZoom(4, -3, 1) - wheelZoom(4, -48, 0)) < 1e-9);
});

test("pinchZoom: spread expands, squeeze compresses, degenerate ratios inert", () => {
  assert.ok(Math.abs(pinchZoom(3, 2) - 5) < 1e-9); // doubling the spread opens two depths
  assert.ok(Math.abs(pinchZoom(5, 0.5) - 3) < 1e-9);
  assert.equal(pinchZoom(4, 1), 4);
  assert.equal(pinchZoom(4, 0), 4);
  assert.equal(pinchZoom(4, NaN), 4);
  assert.equal(pinchZoom(7.5, 100), 8); // clamped
});

test("gaugeFill maps the zoom range onto 0..1", () => {
  assert.equal(gaugeFill(1), 0);
  assert.equal(gaugeFill(8), 1);
  assert.ok(Math.abs(gaugeFill(4.5) - 0.5) < 1e-9);
});
