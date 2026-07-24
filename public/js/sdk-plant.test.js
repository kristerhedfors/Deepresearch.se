// Node tests for the SDK plant greeter's PURE side (sdk-plant.js): the grow-in
// easing and the once-per-browser constants. The DOM greeter itself is
// browser-only and verified live.

import test from "node:test";
import assert from "node:assert/strict";

import { SDK_GREET_KEY, SDK_GREETER_LINES, greeterGrowth } from "./sdk-plant.js";
import { FULL_APEX } from "./plant-spinner.js";

test("greeterGrowth: eases from nothing (0) into full bloom, then pins", () => {
  assert.equal(greeterGrowth(0), 0);
  assert.equal(greeterGrowth(2200), FULL_APEX, "full bloom at the end");
  assert.equal(greeterGrowth(9999), FULL_APEX, "pinned past the end");
  const mid = greeterGrowth(1100);
  assert.ok(mid > 0 && mid < FULL_APEX, "monotone through the middle");
});

test("greeterGrowth is monotonic non-decreasing", () => {
  let prev = 0;
  for (let e = 0; e <= 2400; e += 50) {
    const v = greeterGrowth(e);
    assert.ok(v >= prev - 1e-9, `decreased at ${e}`);
    prev = v;
  }
});

test("greeterGrowth is total: garbage clamps to 0", () => {
  assert.equal(greeterGrowth(Number.NaN), 0);
  assert.equal(greeterGrowth(-500), 0);
  const v = greeterGrowth(100, 0); // dur<=0 falls back to the default, never divides by 0
  assert.ok(Number.isFinite(v) && v >= 0 && v < FULL_APEX);
});

test("greeter constants: a once-flag and plain-text lines", () => {
  assert.equal(SDK_GREET_KEY, "dr_sdk_greeted");
  assert.ok(Array.isArray(SDK_GREETER_LINES) && SDK_GREETER_LINES.length >= 1);
  for (const l of SDK_GREETER_LINES) assert.ok(typeof l === "string" && l.length > 0);
});
