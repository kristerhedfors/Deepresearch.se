// Node tests for the street pane's pure presentation core (street-core.js):
// the compass line, the spawn captions (escaping included — the pane builds
// them with innerHTML), and the overlay placement style.

import { test } from "node:test";
import assert from "node:assert/strict";

import { compassLabel, esc, overlayHtml, overlayLabel, overlayStyle, OVERLAY_BASE_PX } from "./street-core.js";

test("compassLabel names the point, rounds the degrees, and wraps past north", () => {
  assert.equal(compassLabel(0), "N 0°");
  assert.equal(compassLabel(45), "NE 45°");
  assert.equal(compassLabel(270), "W 270°");
  assert.equal(compassLabel(350), "N 350°", "350° rounds to the N point, not off the end of the table");
  assert.equal(compassLabel(-90), "W 270°", "negative headings normalize");
  assert.equal(compassLabel(725), "N 5°", "two turns and a bit is still north");
  assert.equal(compassLabel(44.6), "NE 45°");
});

test("compassLabel appends the imagery date only when there is one", () => {
  assert.equal(compassLabel(90, "2025-06"), "E 90° · imagery 2025-06");
  assert.equal(compassLabel(90, ""), "E 90°");
  assert.equal(compassLabel(90, undefined), "E 90°");
});

test("overlayLabel: creatures carry a level, everything else just a distance", () => {
  assert.equal(overlayLabel({ kind: "creature", name: "Cindron", level: 12, distM: 30 }), "Cindron Lv 12 · 30 m");
  assert.equal(overlayLabel({ kind: "item", name: "tokeball", distM: 60 }), "tokeball · 60 m");
  assert.equal(overlayLabel({ kind: "villain", name: "Rootkit Rex", distM: 90 }), "Rootkit Rex · 90 m");
  assert.equal(overlayLabel({ kind: "creature", name: "Cindron", distM: 5 }), "Cindron · 5 m", "no level → no Lv");
  assert.equal(overlayLabel({ kind: "item", name: "x" }), "x", "no distance → no suffix");
  assert.equal(overlayLabel({}), "");
  assert.equal(overlayLabel(null), "");
});

test("overlay text is escaped — the pane writes it with innerHTML", () => {
  const hostile = { kind: "creature", name: '<img src=x onerror="alert(1)">', level: 3, distM: 10 };
  const html = overlayHtml(hostile);
  assert.ok(!html.includes("<img"), html);
  assert.ok(html.includes("&lt;img"));
  assert.equal(esc('a&b"<>'), "a&amp;b&quot;&lt;&gt;");
  assert.equal(esc(null), "");
  // The emoji is server data, but it goes through the same escape.
  assert.ok(overlayHtml({ emoji: "<script>" }).includes("&lt;script&gt;"));
  assert.ok(overlayHtml({}).includes("❔"), "a spawn with no emoji still renders something tappable");
});

test("overlayStyle applies the server's projection and clamps hostile numbers", () => {
  assert.deepEqual(overlayStyle({ xPct: 70.7, yPct: 62.5, scale: 1 }), {
    left: "70.7%",
    top: "62.5%",
    fontSize: `${OVERLAY_BASE_PX}px`,
  });
  assert.equal(overlayStyle({ scale: 2 }).fontSize, `${OVERLAY_BASE_PX * 2}px`);
  assert.deepEqual(overlayStyle({}), { left: "50%", top: "50%", fontSize: `${OVERLAY_BASE_PX}px` });
  const wild = overlayStyle({ xPct: -40, yPct: 900, scale: 1e6 });
  assert.equal(wild.left, "0%");
  assert.equal(wild.top, "100%");
  assert.equal(wild.fontSize, `${OVERLAY_BASE_PX * 4}px`, "an overlay can never swallow the frame");
  assert.deepEqual(overlayStyle({ xPct: "60", yPct: "40" }), { left: "60%", top: "40%", fontSize: "30px" });
});
